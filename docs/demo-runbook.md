# Demo Runbook — Static Site Deploy to Hostinger

This is the step-by-step to run the MVP pipeline live and demo it. The code is done;
this is the "plug in credentials and run" part.

## What the demo shows

> A project config → GitHub Actions builds the site → the platform engine publishes it
> to Hostinger over SSH into `public_html/releases/<sha>/` → flips the `current` symlink
> to go live → and a one-click rollback flips it back.

No manual server scripting. The engineer only runs a workflow.

## Prerequisites (from you)

1. **A Hostinger account with SSH enabled** (hPanel → Advanced → SSH Access).
   Note the **host/IP**, **SSH port**, and **username** shown there.
   - If the plan is FTP-only (no SSH), the pipeline still works in `ftps-mirror` mode,
     but there is no atomic swap or symlink rollback (rollback = redeploy prior build).
2. **An SSH key pair.** Add the **public** key to the Hostinger account (hPanel SSH →
   Manage SSH keys). Keep the **private** key for the GitHub secret below.
3. A domain/subdomain pointed at the account if you want to show a real URL (optional;
   you can also demo by SSHing in and showing the `current` symlink move).

## One-time setup

### 1. Fill in the project config

Edit `examples/example-site.project.yaml` (or make a copy) with the real values from
hPanel:

```yaml
environments:
  production:
    target:
      driver: hostinger
      host: <your-host-or-ip>
      port: <ssh-port>          # often not 22 on shared hosting
      username: <ssh-username>
      auth: ssh_key
      webroot: public_html
      transfer: rsync
      secret_ref: example_site_hostinger_ssh_key
```

### 2. Add the private key as a GitHub secret

In the repo: **Settings → Secrets and variables → Actions → New repository secret**
- Name: `DEPLOY_SSH_KEY`
- Value: the **private** key contents (the whole `-----BEGIN ... END-----` block)

(If FTPS: add `FTPS_PASSWORD` instead.)

## Dry run first (no changes on the server)

Locally, prove the plan is correct without touching anything:

```
node engine/cli.mjs deploy --config examples/example-site.project.yaml --env production --sha demo123 --dir dist
```

This prints the exact ssh/rsync commands it *would* run. Good to show the director the
determinism and that no secrets are embedded.

## Live deploy (the demo)

In GitHub: **Actions → "Deploy static site" → Run workflow**
- config: `examples/example-site.project.yaml`
- environment: `production`
- execute: **true**

Watch it: checkout → build → upload to `releases/<sha>` → symlink swap → verify.
Then open the site URL (or SSH in and show `ls -l public_html/current`).

## Rollback (the money shot)

In GitHub: **Actions → "Rollback static site" → Run workflow**
- to_sha: a previous release's commit sha
- execute: **true**

The `current` symlink flips back to the prior release instantly. Refresh the site.

## Talking points for the director

- **Generic, not per-project:** the same engine deploys any static site from a config —
  no bespoke scripts.
- **Reversible:** rollback is an atomic symlink flip, not a re-upload.
- **Safe:** secrets live in GitHub, never in the repo or in the printed commands; the
  engine is deterministic and dry-runnable.
- **Extensible:** VPS/Docker (backend + web, blue/green) is the same pattern with more
  drivers — this MVP proves the architecture end to end.

## Known limits of this MVP (be honest)

- Static sites only so far; docker/backend blue-green is the next milestone.
- SSL on Hostinger is managed by the provider (hPanel), not by the platform.
- FTP-only plans lose atomic swap + symlink rollback.
