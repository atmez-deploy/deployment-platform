# Documentation Index

The **atmez-deploy deployment platform** turns "onboard and deploy a project" into a
repeatable, config-driven operation instead of hand-written per-project server scripts.
One generic engine deploys many kinds of projects to many kinds of targets.

- **Static sites** (any framework, or plain HTML) → Hostinger, cPanel, or a VPS.
- **Backend / any service** (any language, containerized) → VPS with Docker blue/green.

New here? Read **[how-it-works.md](how-it-works.md)** then **[usage-guide.md](usage-guide.md)**.

---

## 60-second quickstart

```bash
# 1. See what platforms you can target
node engine/cli.mjs platforms

# 2. Check a platform's prerequisites + validate your inputs (dry, safe)
node engine/cli.mjs preflight --platform hostinger-ftp --config examples/example-site-ftp.project.yaml --environment production

# 3. Dry-run a deploy (prints the exact commands, touches nothing)
node engine/cli.mjs deploy --config examples/example-site-ftp.project.yaml --env production --sha demo --dir dist

# 4. Run for real from GitHub: Actions tab -> "Deploy (select platform)" -> Run workflow
```

Everything runs as a **dry run by default**; real execution needs `--execute` (CLI) or
`confirm: true` (workflow) plus the relevant secret.

---

## Documentation map

### Getting started
- **[usage-guide.md](usage-guide.md)** — step-by-step: add a static site, add a VPS
  service, register, deploy, roll back, onboard many sites.
- **[platform-matrix.md](platform-matrix.md)** — *what deploys where*: app type × target,
  which driver, what's supported.
- **[onboarding.md](onboarding.md)** — the reusable-workflow + generator model, and the
  manual-vs-automatic boundary.

### How it works
- **[how-it-works.md](how-it-works.md)** — architecture, the engine/driver/executor model,
  and the end-to-end deploy flow per target.
- **[language-independence.md](language-independence.md)** — any build tool (or none),
  output-folder auto-detection, and why VPS/Docker is language-agnostic.
- **[architecture-rules.md](architecture-rules.md)** — the 14 rules every change must honor.
- **[master-plan.md](master-plan.md)** — the full phased plan and where we are.

### Reference (design of each part)
- **[schema-design.md](schema-design.md)** — the project configuration schema model.
- **[registry-design.md](registry-design.md)** — the VPS/resource registry + port blocks.
- **[allocator-design.md](allocator-design.md)** — deterministic port/domain allocation.
- **[docker-vps-design.md](docker-vps-design.md)** — the VPS Docker blue/green driver.

### Runbooks (do this to deploy for real)
- **[live-test-runbook.md](live-test-runbook.md)** — safe, isolated live test on a real VPS.
- **[demo-runbook.md](demo-runbook.md)** — static → Hostinger demo.
- **[demo-runbook-vps.md](demo-runbook-vps.md)** — backend → VPS demo.

---

## The mental model in one picture

```
project config (+ registry for VPS)          secrets (GitHub / env)
            │                                          │
            ▼                                          ▼
   ┌─────────────────── engine (pure, deterministic) ───────────────────┐
   │  register → build → driver.plan() → executor.toCommands() → run     │
   └─────────────────────────────────────────────────────────────────────┘
            │ chosen by target.driver / platform
   ┌────────┼─────────────┬───────────────┬───────────────┐
 hostinger  cpanel       vps (docker      static-on-vps
 (ssh/ftp)  (uapi+ftp)    blue/green)
```

- The **engine** never assumes GitHub or a language; it emits a deterministic command
  plan. **Dry run** = print the plan. **Execute** = run it over SSH/curl/rsync.
- **GitHub Actions** is the current control surface (Option A). A dashboard (Option B) can
  be added later as another caller of the same engine.
