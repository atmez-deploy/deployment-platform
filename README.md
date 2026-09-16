# atmez-deploy / deployment-platform

A centralized, generic CI/CD & deployment automation platform for the company.

It turns "onboard a new project" and "deploy a project" into repeatable, config-driven
operations — instead of hand-written per-project server scripts. It supports:

- **Docker services** (backend + frontend) with blue/green deployment on a VPS (and,
  later, cloud targets).
- **Static websites** built in CI and published to a VPS webroot or an external host such
  as Hostinger (SSH/rsync or FTPS).

The platform is **generic**: a project is described by configuration, and one deployment
engine turns that configuration into a project-specific result. There is no per-project
branching in the engine (`if project == gigwala` is forbidden).

## Interface strategy (Option A now, Option B later)

The deployment logic lives in a **GitHub-agnostic engine + drivers** (a standalone
library/CLI). Interfaces are thin callers of that engine:

```
        core engine + drivers  (deterministic, interface-agnostic)
                    │
   ┌────────────────┴────────────────┐
GitHub Actions (Option A, now)   Backend API + Dashboard (Option B, later)
```

Because the engine never assumes it runs inside GitHub Actions, Option B can be added
later as a new caller without rewriting the engine. See `docs/master-plan.md` and
`docs/architecture-rules.md`.

## Documentation

Start at **[docs/README.md](docs/README.md)** — the documentation index. Highlights:
- [how-it-works.md](docs/how-it-works.md) — architecture + end-to-end deploy flow
- [usage-guide.md](docs/usage-guide.md) — step-by-step for each scenario
- [platform-matrix.md](docs/platform-matrix.md) — what deploys where
- [language-independence.md](docs/language-independence.md) — any build tool / auto-detected output
- [onboarding.md](docs/onboarding.md) — reusable workflows + at-scale onboarding

## Status

- **Foundation & engine**: done — schemas, resource registry with per-project port blocks,
  allocator, registration, plan/executor model. Pure, deterministic, GitHub-agnostic.
- **Static pipeline**: done — Hostinger (SSH atomic releases / FTPS), cPanel
  (auto-provisions subdomain + FTP via UAPI), static-on-VPS. Language-independent build
  with output-folder auto-detection.
- **Backend/service → VPS (Docker blue/green)**: done — compose-based, faithful to the
  proven `deploy-backend.sh` flow (pull → health → sed nginx port switch preserving SSL →
  verify → down old), Certbot bootstrap on first deploy.
- **Platform selection + onboarding**: done — `platforms`/`preflight`, unified deploy
  workflow, reusable workflows, and an onboard-site generator.
- **~96 unit tests pass.** Everything runs as a **dry run** today (prints exact commands,
  no secrets). The one thing still unproven is a **live run against a real server** — see
  [live-test-runbook.md](docs/live-test-runbook.md) for the safe way to do it.
- **Not yet built**: least-privilege user hardening, cloud drivers (ECS/K8s), the Option B
  dashboard, Terraform/Ansible. See [master-plan.md](docs/master-plan.md).

## Repository layout (created incrementally, not all at once)

```
deployment-platform/
├── docs/          # master plan, architecture rules, design notes
├── schemas/       # JSON Schema (source of truth) for project configuration
├── examples/      # example project configs validated against the schema
├── engine/        # deterministic deployment engine (later phases)
├── actions/       # composite GitHub Actions wrapping the engine (later)
├── interfaces/    # public / private interface glue (later)
├── config/        # VPS / resource registry (later)
├── infrastructure/# terraform / ansible (later, optional)
├── scripts/
└── tests/
```
