# Demo Runbook — Backend/Service Deploy to VPS (Docker blue/green)

Step-by-step to run the containerized-service pipeline live. The code is complete and
unit-tested; this is the "point it at a real VPS and run" part.

## What the demo shows

> A service config → an already-built image in a registry (GHCR) → the engine deploys it
> to the VPS on the **idle** color → health-checks it → atomically switches Nginx to the
> new color → verifies the live URL → stops the old container. One click rolls traffic back.

No manual Docker/Nginx/systemctl commands. The engineer runs a workflow.

## Prerequisites (from you)

1. **A test VPS** (Ubuntu/Debian) with:
   - **Docker** installed and running.
   - **Nginx** installed, with `/etc/nginx/sites-enabled/` included in the main config.
   - A **deploy user** with SSH access and permission to run `docker` and reload nginx
     (either sudo for `nginx -s reload` / `systemctl reload nginx`, or run as a user with
     the needed rights). Least-privilege hardening is a later step.
2. **SSH key**: public key in the deploy user's `authorized_keys`; the private key added
   as the GitHub secret `DEPLOY_SSH_KEY`.
3. **A container image** in a registry the VPS can pull (e.g. a public GHCR image, or the
   VPS is logged in to GHCR). For a demo, any small web image that serves HTTP 200 works.
4. **The registry file** must have this project+env registered (port + domain allocated).
   The example `config/registry.example.yaml` already registers `example-app/staging` with
   port 5000 and `api.staging.example.com`.

## One-time setup

### 1. Point the registry entry at your VPS

Edit `config/registry.example.yaml` → the `vps-01` entry → set `connection.host`,
`connection.port`, `connection.username` to your test VPS. (The `ssh_key_ref` is just a
name; the actual key comes from the `DEPLOY_SSH_KEY` secret.)

### 2. Pick a demo image + health path

In `examples/example-app.project.yaml`, set the `backend` service's `health.path` to a path
your demo image returns 200 on (e.g. `/`). For a throwaway demo you can use a public image
like a static nginx image that serves `/`.

### 3. Add the SSH key secret

Repo → Settings → Secrets and variables → Actions → `DEPLOY_SSH_KEY` = private key contents.

## Dry run first (no changes on the server)

```
node engine/cli.mjs deploy-service \
  --config examples/example-app.project.yaml --env staging --service backend \
  --registry config/registry.example.yaml \
  --image <your-image-ref>
```

Prints the exact ssh/docker/nginx commands it *would* run. Great for showing the director
the determinism and that no secrets appear in the commands.

## Live deploy (the demo)

GitHub → Actions → **"Deploy service (VPS Docker blue/green)"** → Run workflow:
- config: `examples/example-app.project.yaml`
- registry: `config/registry.example.yaml`
- environment: `staging`, service: `backend`
- image: `<your-image-ref>`
- execute: **true**

Watch: determine color → pull → run idle container → health check → nginx switch → verify
→ stop old. Then open the domain (or `curl -H 'Host: api.staging.example.com' http://<vps>`).

## Rollback (the money shot)

GitHub → Actions → **"Rollback service (VPS Docker blue/green)"** → Run workflow with
`execute: true`. Nginx flips back to the previous color instantly.

## Talking points for the director

- **Generic, config-driven:** same engine deploys any service from config; no bespoke
  server scripts (Rule 1).
- **Zero-touch blue/green:** new version is health-checked before any traffic moves;
  switch is an atomic Nginx reload; rollback is instant (Rule 8).
- **Isolated:** container/network/nginx names derive from project+env, so projects can
  share a VPS without interfering (Rule 2).
- **Safe & auditable:** deterministic plan, dry-runnable, secrets never in the repo or the
  printed commands (Rules 3, 14).

## Known limits of this MVP (be honest)

- Single host-port per service (stop-old then start-new on switch). True zero-downtime
  dual-port overlap is a refinement.
- SSL config is stubbed with a TODO (Certbot automation is a later step).
- Assumes the database already exists; only runs the declared migration command.
- Deploy-user least-privilege hardening (Phase 4) is not yet applied.
