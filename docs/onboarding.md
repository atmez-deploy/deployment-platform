# Onboarding a New Site — Manual vs Automatic

Goal: add any number of sites without hand-writing CI/CD each time. The deploy logic lives
once in this platform's **reusable workflow**; each site just calls it. The **onboard-site**
workflow wires a new repo up automatically.

## The boundary

### One-time, manual (unavoidable)
- **Install a GitHub App (or create a PAT) on the `atmez-deploy` org**, with access to the
  site repos and permissions: **Contents (write)**, **Secrets (write)**, **Actions (write)**.
  Store its token as the `ONBOARD_TOKEN` secret on the `deployment-platform` repo.
  Why manual: GitHub only lets an outside workflow write into a repo if it has been granted
  access — this is a security boundary, done once.

### Per-site, manual (Hostinger limitation)
- **Create the FTP account + password and the subdomain in hPanel**, once per site.
  Why manual: Hostinger shared hosting has no API to create FTP accounts/subdomains, so this
  step can't be automated. (On VPS targets, this whole step goes away — the platform
  provisions users/dirs/domains itself in a later phase.)

### Everything else — automatic
Run the **Onboard site** workflow (`.github/workflows/onboard-site.yml`) with the repo,
domain, auth mode, and the FTP credentials. It will:
1. Write `deploy.project.yaml` into the target repo.
2. Write `.github/workflows/deploy.yml` (the ~10-line caller) into the target repo.
3. Set the repo's secrets (`FTP_PASSWORD`, etc.) — encrypted via the repo public key.
4. Trigger the first deploy.

From then on, every push to the site repo deploys through the central reusable workflow.

## How the pieces fit

```
site repo:  deploy.project.yaml + .github/workflows/deploy.yml (caller)  + secrets
                     │  calls (workflow_call)
                     ▼
platform:   .github/workflows/_deploy-static.reusable.yml   (the logic, once)
                     │  runs
                     ▼
            engine/cli.mjs  ->  driver (ssh releases | ftps mirror)  ->  Hostinger
```

- Update the logic once in `_deploy-static.reusable.yml` → all sites get it. No per-repo
  copies to maintain.
- Roll back a site: run its `deploy.yml` caller against a prior commit, or (SSH plans) the
  rollback flow. FTP-only plans roll back by redeploying the prior build.

## Adding a site (the whole checklist)

1. (once) GitHub App installed + `ONBOARD_TOKEN` set. (once) done.
2. In hPanel: create the FTP account + subdomain for the site. Note host/user/password.
3. Run **Onboard site**: enter `owner/repo`, `domain`, `auth=ftps`, and provide the FTP
   creds as the workflow's `SITE_FTP_*` secrets.
4. Done — the site is deploying. Future pushes auto-deploy.

## Secret names (convention)

Per-site repo secrets used by the reusable workflow:
- `FTP_PASSWORD` (required for ftps), optionally `FTP_HOST` / `FTP_USERNAME` / `FTP_WEBROOT`
- `DEPLOY_SSH_KEY` (for ssh_key plans)

On the platform repo (for the generator):
- `ONBOARD_TOKEN` — the GitHub App/PAT token.
- `SITE_FTP_PASSWORD` / `SITE_FTP_HOST` / `SITE_FTP_USERNAME` / `SITE_DEPLOY_SSH_KEY` — the
  values to install into the target repo during onboarding.

---

## Onboarding a VPS/Docker SERVICE (backend, worker, API)

Same one-click model, different target. The service repo's own CI builds+pushes the image;
the platform deploys it blue/green to the VPS.

### One-time / prerequisites
- The same GitHub App/`ONBOARD_TOKEN` as for static sites.
- A VPS present in the resource registry (with Docker + Nginx + a deploy user), and its
  `DEPLOY_SSH_KEY`.
- The project+environment **registered** in the registry so a port + domain are allocated
  (this is the resource-allocation step; without it, deploy-service will refuse because no
  port/domain is reserved).

### Automatic (onboard-site generator, service mode)
```
GH_TOKEN=... DEPLOY_SSH_KEY=... node tools/onboard.mjs \
  --kind service --repo owner/name --domain api.example.com \
  --vps-ref vps-01 --service backend --environment staging
```
This writes a docker `deploy.project.yaml`, the service caller workflow
(`.github/workflows/deploy.yml`), and sets `DEPLOY_SSH_KEY` in the repo. It does NOT
auto-deploy — a service deploy needs an image reference, which the repo's CI produces.

### Deploying
After the repo's CI builds+pushes an image, run the repo's **Deploy service** workflow
(or the central `deploy-service.yml`) with the immutable image ref. The engine does:
pull → start idle color → health check → atomic Nginx switch → verify → stop old.
Rollback = the `rollback-service` flow (Nginx switch back).

### Reusable workflow
The logic lives once in `.github/workflows/_deploy-service.reusable.yml`; the service repo
caller (`examples/caller-deploy-service.yml`) is ~15 lines.

---

## Unified deploy: pick a platform (Level 1)

The `Deploy (select platform)` workflow (`.github/workflows/deploy.yml`) is a single
entrypoint where you choose the target platform and it does the rest:

1. **Preflight** — prints that platform's manual checklist and validates the required
   inputs/secrets are present (fails fast if not).
2. **Dry run** — prints the exact commands (no changes) — this always runs.
3. **Deploy** — runs for real only when `confirm: true`.

Platforms (see `engine/platforms.mjs`):
- `vps` — full auto-deploy (Docker blue/green). Needs `DEPLOY_SSH_KEY`, a registered
  project (port block + domains), and image ref(s).
- `hostinger-ssh` — static, SSH releases + symlink rollback. Manual: SSH enabled,
  subdomain created. SSL managed by hPanel.
- `hostinger-ftp` — static, FTPS mirror (no atomic rollback). Manual: FTP account +
  subdomain. SSL managed by hPanel.

CLI equivalents:
```
node engine/cli.mjs platforms                 # list selectable platforms
node engine/cli.mjs preflight --platform vps --config ... --environment ...   # checklist + validate
```

Note on the UX ceiling: GitHub Actions inputs are a flat form (no conditional fields based
on the platform choice). A dynamic per-platform form/wizard is an Option B (dashboard)
feature; Level 1 delivers the pick-validate-dryrun-deploy flow within Actions' limits.
