# Centralized CI/CD & Deployment Automation Platform — Master Plan

This is the reference document for the platform. We complete each phase and validate it
before moving to the next. We do not skip ahead.

## 1. Problem

Onboarding/deploying a project today requires manual, per-project DevOps work: create VPS
user, directories, ports, Docker Compose, networks, deploy scripts, Nginx, SSL, env,
GitHub secrets, workflows, SSH testing, and manual fixes. This causes drift between
projects, requires server knowledge and SSH access, risks port conflicts and cross-project
interference, duplicates blue/green logic, and makes onboarding slow.

### Goal

```
New Project → GitHub Onboarding Workflow → Central Platform
           → automatically provision/configure → Project ready → Normal GitHub deployment
```

A new DevOps engineer should not need SSH access for normal onboarding or deployment.

## 2. Fundamental architecture

A company-wide, **generic** deployment platform (not a project-specific script). No
`if project == X` branching. Flow:

```
Project configuration → Generic deployment engine → Project-specific result
```

## 3. Interface strategy: Option A first, Option B later

- **Option A (now):** the engine runs inside GitHub Actions. Repos call reusable
  workflows. GitHub provides runners, secret storage, triggers, approvals, and audit.
- **Option B (later, optional):** a standalone backend + dashboard product, self-hosted,
  that calls the same engine.

The engine is built **GitHub-agnostic** so B is an additive new caller, not a rewrite.
See `architecture-rules.md` (Rules 6, 11) and `schema-design.md`.

## 4. Deployment types & target drivers (the core generalization)

Two orthogonal axes:

```
deployment type            target driver (where + how to publish)
──────────────             ───────────────────────────────────────
docker   (long-running) ×  vps        (ssh: docker + nginx, blue/green)
static   (build→files)     hostinger  (ssh/rsync or ftps → public_html)
                           netlify    (api/cli)           [future]
                           s3_cdn     (sync + invalidate) [future]
```

The engine resolves `target.driver` to a driver and calls a fixed contract:
`validate / provision / publish / activate / verify / rollback / cleanup`.
New hosting = new driver, no engine change.

## 5. Project identity & isolation

Every resource carries `project + environment` identity, used for filesystem, Docker
container/network names, Nginx config file, state, and lock. Multiple projects share a VPS
without interfering. On shared external hosting (e.g. Hostinger), OS-level isolation is not
possible — isolation there comes from separate hosting accounts/domains, and the schema
records this honestly.

## 6. Static websites

Build in CI → produce a bundle (e.g. `dist/`) → publish via a driver.
- VPS: `releases/<sha>/` + `current` symlink swap (atomic, rollback = symlink flip).
- Hostinger: rsync over SSH into `public_html/releases/<sha>` + symlink swap when SSH
  allows; FTPS upload as fallback. SSL is managed by the provider (hPanel), not Certbot.

## 7. Implementation phases

- **Phase 1 — Foundation:** org + repo (DONE); repo security/access.
- **Phase 2 — Architecture:** schemas for project, environment, service, exposure,
  target/VPS, secrets, deployment state. **(IN PROGRESS — Step 3)**
- **Phase 3 — Resource manager:** VPS registry, project registration, resource + port
  allocation, filesystem + Docker provisioning.
- **Phase 4 — Identity:** deployment-user creation, SSH keys, permissions, least privilege.
- **Phase 5 — Networking:** Docker networks, Nginx generation, domain routing, port
  exposure, SSL.
- **Phase 6 — Deployment engine:** driver interface, image/bundle publish, blue/green,
  health checks, migrations, traffic switch, live verification, rollback, cleanup.
- **Phase 7 — GitHub integration:** public/private interface, GitHub environments,
  secrets, approvals, concurrency.
- **Phase 8 — Onboarding:** `onboard-project` workflow, validate, provision, configure
  GitHub, initial deploy, return result.
- **Phase 9 — Infrastructure automation:** evaluate/apply Terraform + Ansible (optional).
- **Phase 10 — Testing:** single-project, multi-project same-VPS, failure, rollback,
  security, concurrency.
- **Phase 11 — Production migration:** migrate Gigwala staging → prod, then other
  projects; retire old per-project scripts.
- **Phase 12 — (Optional) Backend + Dashboard product (Option B):** API, secret store,
  auth, dashboard — as a new caller of the existing engine.

## 8. Testing strategy

Never test against production first. Use a test VPS. Validate onboarding, existing/missing
user, permissions, directory creation, port allocation, Docker/network/Nginx isolation,
domain + port deployment, SSL, blue/green, migration, failed deploy, failed health check,
rollback, simultaneous deployments, server restart, cleanup.

## 9. Migration from current scripts

Keep existing `deploy-*.sh` until the new platform is proven on Gigwala staging, compared,
fixed, then production. Remove old scripts last.
