# Usage Guide

Step-by-step for the common tasks. Every command is a **dry run** until you add
`--execute` (CLI) or `confirm: true` (workflow). Commands are run from the platform repo.

Prereqs: Node 20+. `npm install` once (installs the engine's deps).

---

## 1. Deploy a static site (Hostinger)

**1. Write a project config** (or copy an example). Minimum:

```yaml
schema_version: "1.0"
project: { name: my-site }
repository: { organization: my-org, repository: my-site }
environments:
  production:
    deployment: { type: static }
    target:
      driver: hostinger
      host: ftp.example.com
      username: u123
      auth: ftps          # or ssh_key for atomic releases
      webroot: public_html
      transfer: ftps
      secret_ref: my_site_ftp_password
    build:
      command: npm ci && npm run build   # or 'hugo', or omit for plain HTML
      # output_dir: dist                 # optional — auto-detected if omitted
    services:
      site:
        exposure: { type: domain, domain: www.example.com, ssl: managed_by_provider }
```

**2. Preflight** (checklist + validate you have what's needed):
```bash
node engine/cli.mjs preflight --platform hostinger-ftp --config my-site.project.yaml --environment production
```

**3. Dry run** (prints the exact upload commands):
```bash
node engine/cli.mjs deploy --config my-site.project.yaml --env production --sha "$(git rev-parse HEAD)" --dir dist
```

**4. Deploy for real** — from GitHub: **Actions → "Deploy (select platform)" → Run
workflow**, choose `hostinger-ftp`, set `confirm: true`. Provide the `FTP_PASSWORD` secret.

Rollback: SSH plans redeploy the previous release via the symlink; FTP plans redeploy the
prior build.

---

## 2. Deploy a static site with automated provisioning (cPanel)

cPanel can create the subdomain + FTP account for you.

```bash
# checklist + validate (needs CPANEL_API_TOKEN)
node engine/cli.mjs preflight --platform cpanel --config examples/example-cpanel.project.yaml --environment production
# dry run
node engine/cli.mjs deploy-cpanel --config examples/example-cpanel.project.yaml --env production --dir dist
```
Real run: the **Deploy (select platform)** workflow with platform `cpanel` (once wired to
your caller), or run `deploy-cpanel --execute` with `CPANEL_API_TOKEN` in the env.

---

## 3. Deploy a backend / service (VPS, Docker blue/green)

**Order matters:** register once, then deploy.

**1. Ensure the VPS is in the registry** (`config/registry.example.yaml`) with a
`port_block`, and fill its `host` / `username`.

**2. Register the project** (allocates a port block + records ports/domains):
```bash
node engine/cli.mjs register --config examples/example-service.project.yaml --env staging --registry config/registry.example.yaml
# add --execute to write it; or run the "Register project" workflow with execute:true
```

**3. Build + push the image** — the app repo's own CI builds and pushes to a registry
(e.g. GHCR). The platform deploys, it doesn't build your image.

**4. Deploy** (dry run, then real):
```bash
node engine/cli.mjs deploy-service \
  --config examples/example-service.project.yaml --env staging \
  --registry config/registry.example.yaml \
  --image backend=ghcr.io/org/backend:<sha> --image web=ghcr.io/org/web:<sha>
```
Real run: **Actions → "Deploy service (VPS Docker blue/green)"** with `confirm: true` and
the `DEPLOY_SSH_KEY` secret.

**Rollback:** the **Rollback service** workflow — flips nginx back to the previous color.

---

## 4. Onboard many sites at scale

Write the CI/CD once (the reusable workflow); each site gets a ~10-line caller. The
**Onboard site** workflow can write that caller + set secrets into a target repo
automatically. Full details + the manual-vs-automatic boundary:
see **[onboarding.md](onboarding.md)**.

---

## 5. Safe live test on a real VPS

To prove the whole thing end-to-end without risking a production app, use the isolated
`hello-test` project and the step-by-step **[live-test-runbook.md](live-test-runbook.md)**.

---

## Cheat sheet

```bash
node engine/cli.mjs platforms                          # list targets
node engine/cli.mjs preflight --platform <id> ...      # checklist + validate
node engine/cli.mjs register  --config .. --env .. --registry ..   # VPS: allocate resources
node engine/cli.mjs deploy         --config .. --env .. --sha .. --dir ..     # static
node engine/cli.mjs deploy-cpanel  --config .. --env .. --dir ..              # cPanel static
node engine/cli.mjs deploy-service --config .. --env .. --registry .. --image name=ref  # VPS
# add --execute to any deploy to run for real
```

Validation & tests (for platform developers):
```bash
node tools/validate.mjs        # example configs vs schema
node tools/negative-check.mjs  # schema rejects bad configs
node tools/run-tests.mjs       # engine unit tests
```
