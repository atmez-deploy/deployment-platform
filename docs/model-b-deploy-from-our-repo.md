# Model B — deploy client sites from OUR repo

Model B lets you deploy a client's site without adding anything to their repository. They
give you a link; you record it once in `config/projects.yaml`; the platform clones, builds,
and publishes it. Two ways to trigger a deploy: a **button** (always available) and an
optional **webhook** (auto-deploy on the client's push).

## The pieces

| Piece | File | Role |
| --- | --- | --- |
| Project registry | `config/projects.yaml` | one entry per client: repo URL, build, target |
| Resolver (pure) | `engine/projects.mjs` | turns one entry into a deploy config the engine consumes |
| CLI commands | `engine/cli.mjs` | `list-projects`, `resolve-project` |
| Workflow | `.github/workflows/deploy-from-registry.yml` | clone → build → deploy; button + webhook |
| Client trigger (optional) | `examples/client-trigger-deploy.yml` | client-side notifier for the webhook path |

## Onboarding a client (once)

1. Get the client's repo link. If it's private, get a read token and store it as a repo
   secret; name that secret in the entry's `repo_token_ref`.
2. Add an entry to `config/projects.yaml` (copy the commented template). Fill in `repo`,
   `branch`, `build` (command/output_dir, or `spa: true` for router apps), and `target`.
3. Add the deploy credential (e.g. the SSH key) to this repo's Actions secrets under the
   name in `target.secret_ref`.

That's it. The client did one thing: sent a link.

## Triggering a deploy

### Button (always works)
Actions tab → **Deploy from registry** → enter the project `id` → Run. It defaults to a
dry run; check `execute` to publish for real. This needs no setup on the client side.

### Webhook (optional auto-deploy)
The workflow already listens for a `repository_dispatch` event of type `deploy-project`
with `client_payload.id = "<project-id>"`. Anything that sends that event deploys the
project for real. The simplest source is a tiny notifier in the client's repo
(`examples/client-trigger-deploy.yml`): on their push it POSTs to our repo's `dispatches`
API. Webhook deploys run `--execute` (that is the point of auto-deploy).

**Rule: webhook if available, else button.** If a client can't or won't set up the
notifier, you lose nothing — you deploy them with the button. The webhook is purely an
upgrade that makes their push auto-deploy.

## How a run works (both triggers)

1. Check out THIS repo (engine + registry).
2. `resolve-project` the requested `id` → clone info + a generated deploy config.
3. Clone the client repo (token-injected via header for private repos, nothing written to
   `.git/config` on disk).
4. Build inside the clone using the entry's `build.command` (any language) or `build.image`;
   resolve the output folder (explicit or auto-detected).
5. Deploy via the engine — the same proven static driver used everywhere else.

## Security notes

- No secrets live in `config/projects.yaml`; only the *names* of secrets (`secret_ref`,
  `repo_token_ref`). Values stay in Actions secrets.
- Private-repo tokens are injected via an `http.extraheader`, never persisted to disk.
- If a project's deploy secret uses a non-default name, the workflow maps it onto the env
  var the engine reads at run time.

## Verify locally (dry run)

```
node engine/cli.mjs list-projects --projects config/projects.yaml
node engine/cli.mjs resolve-project --projects config/projects.yaml --id <id> --out .tmp.yaml
node engine/cli.mjs deploy --config .tmp.yaml --env production --sha local --dir <output_dir>
```

The last command prints the exact ssh/rsync commands without touching anything.
