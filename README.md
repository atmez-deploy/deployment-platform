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

## Status

- **Foundation & schemas** (Phase 1–2): done — project config schema, resource registry,
  architecture rules, validation + negative tests in CI.
- **Engine core**: done — resource/port allocator, project registration, plan/executor
  model. All pure, deterministic, GitHub-agnostic, unit-tested (`npm test`).
- **Static → Hostinger pipeline**: code-complete — driver (SSH releases + symlink swap,
  FTPS fallback), CLI, `deploy-static` / `rollback-static` workflows. See
  `docs/demo-runbook.md`. Real live deploy pending Hostinger SSH access.
- **Backend/service → VPS (Docker blue/green)**: code-complete — driver (pull → idle
  color → health check → atomic Nginx switch → verify → stop old), nginx config
  generation, CLI `deploy-service` / `rollback-service`, workflows. See
  `docs/demo-runbook-vps.md`. Real live deploy pending a test VPS.
- **Not yet built**: least-privilege user provisioning, SSL/Certbot automation, cloud
  drivers (ECS/K8s), onboarding workflow, Terraform/Ansible. See `docs/master-plan.md`.

Both pipelines can be shown as **dry runs today** (they print the exact commands without
touching a server); live demos need the respective target access.

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
