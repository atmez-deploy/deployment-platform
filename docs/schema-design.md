# Project Configuration Schema — Design Notes

Source of truth: `schemas/project.schema.json` (JSON Schema draft 2020-12).
Humans author YAML/JSON project configs; the platform validates them against the schema.

## Two orthogonal axes

```
deployment.type            target.driver (where + how to publish)
──────────────             ───────────────────────────────────────
docker   (long-running) ×  vps        (ssh: docker + nginx, blue/green)
static   (build→files)     hostinger  (ssh/rsync or ftps → public_html)
                           netlify    (api/cli)           [future]
                           s3_cdn     (sync + invalidate) [future]
```

The engine never hardcodes a provider. It resolves `target.driver` to a driver and calls
a fixed contract: `validate / provision / publish / activate / verify / rollback / cleanup`.

## Interface boundaries (Rule 11)

The engine consumes:
- `InputContext`: `{ project, environment, target, imageRef|commit, triggeredBy }`.
- `SecretProvider`: `get(name)`.
- `StateStore`: deployment state + audit.

The **config file never contains secrets** (Rule 3). It references what it needs by name;
the caller supplies values through `SecretProvider`.

## Deployment types

### `docker`
- Artifact = image reference (`ghcr.io/...@sha`).
- `activate` = blue/green traffic switch. Has ports, networks, health endpoints, migrations.

### `static`
- Artifact = a build bundle (`build.output_dir`, e.g. `dist/`), produced in CI.
- `activate` = atomic release swap. On VPS: `releases/<sha>/` + `current` symlink.
  On Hostinger: rsync into `public_html/releases/<sha>` + symlink swap (SSH), else FTPS.

## Decisions locked for Step 3

1. Hostinger transfer: **SSH/rsync primary, FTPS fallback**.
2. Static rollback history for Hostinger: keep `releases/` **on the Hostinger account when
   SSH is available**; central tracking only for FTPS-only accounts.
3. Builds run in **GitHub Actions CI**; the engine only publishes the produced bundle.
4. Schema format: **JSON Schema (2020-12)** source of truth; YAML configs validated against it.

## Identity & isolation by scenario

| Concern      | docker on VPS                   | static on VPS                        | static on Hostinger                       |
|--------------|---------------------------------|--------------------------------------|-------------------------------------------|
| Filesystem   | `/opt/deployments/<p>/<env>/`   | `/opt/deployments/<p>/<env>/static/` | `<account>/public_html`                   |
| Live pointer | nginx upstream → blue/green     | `current` symlink → release dir      | symlink or `public_html` contents         |
| Isolation    | user + network + ports          | own dir + own nginx `.conf`          | separate hosting account / domain         |
| SSL          | Certbot (platform)              | Certbot (platform)                   | managed by provider (hPanel)              |
| State/lock   | `state/deploy.lock`             | `state/deploy.lock`                  | on-account releases or central state      |

## Top-level shape

```
project:        { name }
repository:     { organization, repository, default_branch }
defaults:       (optional) values inherited by every environment
environments:
  <env-name>:
    deployment: { type: docker|static, strategy?: blue_green|recreate }
    target:     { driver, ... }        # vps | hostinger | netlify | s3_cdn
    user?:      { name }               # vps deployment identity
    build?:     { command, output_dir } # required for static
    database?:  { name, migrate }
    services:
      <service-name>:
        image?:            # docker only
        exposure:          # domain | port | internal
        health?:           # health check config
        release_strategy?: # static only: symlink | mirror | ftps_upload
```
