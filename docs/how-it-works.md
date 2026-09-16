# How It Works

This explains the architecture and what actually happens during a deploy. It is the
"read this first" technical overview.

## Core idea

A project is **described by configuration**; one **generic engine** turns that
configuration into a project-specific deployment. There is no per-project logic in the
engine (`if project == X` is forbidden — architecture Rule 1). Adding a new hosting
provider means adding a **driver**, not changing the engine.

## The moving parts

```
schemas/         JSON Schema: what a project config / registry may contain (source of truth)
config/          the resource registry (which VPS exist, port blocks, allocations)
engine/          the deterministic engine (pure logic, no GitHub, no language assumptions)
  drivers/         one module per target: static-hostinger, cpanel, docker-vps
  registry.mjs     resolve target.ref; port-block allocation
  register.mjs     assign a project its ports/domains (writes the registry)
  allocator.mjs    deterministic port/domain allocation
  nginx.mjs        nginx config generation (VPS)
  compose.mjs      docker-compose generation (VPS)
  executor.mjs     turn a driver PLAN into concrete ssh/docker/curl/rsync commands
  platforms.mjs    the selectable-platform registry + preflight
  cli.mjs          the single entrypoint every caller uses
tools/           validators, test runner, output auto-detection, onboarding generator
.github/workflows/ thin GitHub Actions that call the CLI (the Option A interface)
```

## The pipeline: plan → commands → run

Every driver follows the same shape, which is what makes the platform testable and safe:

```
1. driver.planDeploy(config)      -> a deterministic STEP PLAN (pure data, no side effects)
2. executor.toCommands(plan)      -> concrete shell commands (ssh/docker/curl/rsync)  [pure]
3. runPlan(..., execute:true)     -> actually runs them                               [impure]
```

- **Dry run** stops after step 2 and prints the commands. Nothing is touched, no secrets
  appear in the output (only env-variable references like `$DEPLOY_SSH_KEY`).
- **Execute** runs step 3. This is the only impure part.

This separation means the hard logic (sequencing, blue/green, nginx/compose generation,
port allocation) is all pure and unit-tested; ~96 tests cover it.

## Where config, registry, and secrets fit

- **Project config** (`examples/*.project.yaml`) — what to deploy: services, images,
  domains, build, target. Contains **no secrets** (Rule 3).
- **Registry** (`config/registry*.yaml`) — infrastructure inventory for VPS targets: which
  boxes exist, their port blocks, and each project's allocated ports/domains.
- **Secrets** — SSH keys, FTP passwords, API tokens. Referenced by *name* in config;
  values injected at run time via env (GitHub Secrets today). Never committed.

## Flow: static site (Hostinger / cPanel / VPS)

```
build (any tool, or none)                  ← runs the project's own build.command
   └─ output folder auto-detected          ← or build.output_dir if set (tools/detect-output)
        └─ publish
             hostinger-ssh : rsync into releases/<sha>, atomic `current` symlink swap
             hostinger-ftp : lftp mirror into webroot (no atomic swap)
             cpanel        : UAPI create subdomain (+FTP), then upload
             static-on-vps : releases/<sha> + symlink swap, nginx + Certbot
        └─ verify (https if SSL, else the served path)
```

Rollback (SSH targets): flip the `current` symlink back. FTP: redeploy the prior build.

## Flow: backend/service on VPS (Docker blue/green)

This mirrors the deployer's proven `deploy-backend.sh`, generalized for any project:

```
read active_env  →  TARGET = idle color, OLD = current color
write per-color docker-compose.app.yml (ports from the registry block)
docker compose -p <project>-<TARGET> pull ; up -d --force-recreate
(optional) run migrations in the TARGET backend container
health-check each service on its TARGET port (curl -fs, retries)
first deploy only: write nginx conf (HTTP) → enable → nginx -t → reload → Certbot
switch: sed the `set $<svc>_port` values in the EXISTING nginx conf  ← preserves SSL
nginx -t && reload            ← atomic traffic switch
echo TARGET > active_env
verify live (https per domain)
docker compose -p <project>-<OLD> down     ← bring the old color down
```

Rollback: bring the OLD color up, sed the ports back, reload, restore the marker.

Isolation (Rule 2): container/network/nginx-conf names and a per-project **port block**
are derived from `project + environment`, so many projects share one VPS without collision.

## Language & folder independence

- **Build:** any command (`npm`, `hugo`, `bundle`, `make`, …), optionally inside a
  `build.image` container; or no build (serve files as-is).
- **Output folder:** auto-detected from what the build produced (or set `output_dir`).
- **Backends:** the VPS driver deploys a container **image** — Node/Python/Go/Java/PHP/…
  all deploy identically. The engine never inspects the language.

See [language-independence.md](language-independence.md).

## Interfaces: Option A now, Option B later

The engine is **interface-agnostic** (Rule 11): it takes normalized inputs and never reads
`GITHUB_*`. Today the caller is **GitHub Actions**. A **backend + dashboard** (Option B)
could be added later as another thin caller of the same CLI/engine — no engine rewrite.

## Determinism & safety

- No LLM/agent in the deploy path (Rule 14): plans are pure, reproducible, auditable.
- Secrets are never embedded in plans or printed output.
- Every deploy is a dry run until explicitly executed.
