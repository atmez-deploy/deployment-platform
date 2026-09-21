# Backend deployment lifecycle (who does what)

The goal: after a one-time setup, a client's backend repo runs the whole pipeline itself —
build image, push to registry, pull on the server, blue/green deploy — on every push.

## One-time setup (WE do it)

### 1. Server setup (once per VPS)
Prepare the box: Docker + nginx + certbot, a deploy user, base directories.

```
# dry run first (prints the exact ssh commands)
node engine/cli.mjs server-setup --registry config/registry.yaml --ref <vps-id> \
  --deploy-user deployer --pubkey ./deploy_key.pub

# run it
node engine/cli.mjs server-setup --registry config/registry.yaml --ref <vps-id> \
  --deploy-user deployer --pubkey ./deploy_key.pub --execute
```

- `--pubkey` authorizes the deploy PUBLIC key for the deploy user (the matching private key
  is the client repo's `DEPLOY_SSH_KEY` secret).
- Idempotent — safe to re-run. Add `--skip-packages` if Docker/nginx are already installed.
- Or pass `--host <h> --username <u> [--port <p>]` instead of `--registry/--ref`.

### 2. Register the project (once per project+env)
Allocate a port block + record the domains in our registry.

```
node engine/cli.mjs register --config <project.yaml> --env production \
  --registry config/registry.yaml --execute
```

### 3. Set up the client repo (once)
Write the CI/CD workflow + config into the client repo and set the deploy secret.

```
GH_TOKEN=... node engine/cli.mjs  # (onboarding tool)
node tools/onboard.mjs --kind service --repo owner/name --domain api.example.com \
  --service backend --vps-ref <vps-id> --environment production [--via-pr]
```

## Every push after (the CLIENT's repo does it, automatically)

The generated workflow in the client repo, on each push to their branch:

1. **Build** the Docker image from their code.
2. **Push** it to GHCR, tagged with the commit SHA (immutable).
3. **Deploy** — calls our reusable workflow, which SSHes to the server and:
   - `docker compose pull` the new image onto the idle color
   - `up -d --force-recreate` the idle color
   - run migrations (optional)
   - health-check the idle color
   - switch nginx to the idle color's ports, reload (SSL preserved)
   - mark the new color active
   - bring the old color down

The server only **pulls and runs** — it never builds. Build/push lives entirely in the
client repo's CI. We only did the initial server + repo setup.

## Rollback

```
node engine/cli.mjs rollback-service --config <project.yaml> --env production \
  --registry config/registry.yaml --execute
```

Brings the previous color back up and switches nginx back to it.
