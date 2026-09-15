# VPS Docker Blue/Green Deployment — Design Notes

The `docker-vps` driver deploys a long-running service (backend, web, worker) to our own
VPS using containers and a blue/green swap. Like the static driver, the planning logic is
**pure and deterministic** (Rules 6, 11, 14): it emits an ordered step plan; the executor
turns steps into `ssh`/`docker` commands; a thin runner executes only when told to.

## Identity (Rule 5)

Every resource name derives from `<project>-<environment>-<service>` plus a color:

```
container   <project>-<environment>-<service>-<color>     e.g. example-app-staging-backend-blue
network     <project>-<environment>-network               e.g. example-app-staging-network
nginx conf  <project>-<environment>-<service>.conf
```

`color ∈ { blue, green }`. This guarantees isolation between projects/environments on a
shared VPS (Rule 2).

## Blue/green model (Rule 8 — reversible)

```
             ┌─ blue  (currently LIVE) ─┐
 nginx ──────┤                          │  upstream points at ONE color
             └─ green (currently IDLE) ─┘
```

Deploy flow (new version goes to the IDLE color):

```
1. determine_active   read which color nginx currently points to (default: none -> blue)
2. pull               docker pull <image@sha> on the VPS
3. run_container      start <service>-<idle> on its allocated host port, on the project network
4. health_check       probe the new container's /health (or configured path) until healthy
5. nginx_write        render the site config with upstream -> the NEW (idle) color's port
6. nginx_reload       nginx -t && reload  (atomic switch of live traffic)
7. verify_live        probe the public URL returns expected status
8. stop_old           stop + rm the previously-active container
```

If any step before `nginx_reload` fails, we abort without touching live traffic — the old
color is still serving. If `verify_live` fails *after* the switch, we roll back (below).

## Rollback (Rule 8)

```
1. determine_active   find the current (bad) color
2. assert_other_exists ensure the previous color's container is still running
3. nginx_write        upstream -> the previous color's port
4. nginx_reload       atomic switch back
5. verify_live        confirm restored
```

Rollback is just another nginx upstream switch — fast and safe. The prior container is not
removed until a subsequent successful deploy's `stop_old`, so it's always available to
switch back to.

## State: which color is live?

The driver must not guess. It reads the current state from the VPS. Two options; we use
the **nginx-config-as-truth** approach for the MVP: the active color is whatever the
generated upstream currently points to (parsed from the conf file). A small marker file
`<base>/<project>/<env>/state/active_color` is also written on each switch as an explicit,
easy-to-read record (and for the audit trail, Step 38).

## Ports & networks

- The **allocator** (already built) grants each service a host port from the VPS pool. Both
  colors of a service share the same *concept* but bind different runtime ports; for the MVP
  we bind the allocated port to whichever color is going live and stop the old one, so only
  one host port per service is needed. (A future refinement can reserve two ports for true
  zero-downtime overlap.)
- Each project+environment gets its own Docker network so containers can talk internally
  without exposing ports (Rule 2). Nginx routes public traffic in.

## Health checks (Step 16 / 29)

```
health:
  path: /api/health     # HTTP path on the container
  expect_status: 200
  timeout_seconds: 30
  retries: 5
```

Probed by `curl` from the VPS against the new container before any traffic switch.

## SSL

For `exposure.ssl: true` on a `vps` target, the platform provisions a cert (Certbot) —
that is a later step; the MVP driver renders HTTP config and leaves an explicit TODO marker
rather than pretending SSL is handled (Rule 13).

## What the driver does NOT do

- No DB provisioning. Migrations are a declared step (`database.migrate`) run against the
  new container before the switch; the DB itself is assumed to exist (later phase).
- No LLM/agent in the path (Rule 14). Pure plan → commands → run.

## Step plan (typed)

Deploy steps: `determine_active`, `pull`, `ensure_network`, `run_container`,
`migrate` (optional), `health_check`, `nginx_write`, `nginx_reload`, `verify_live`,
`write_active_marker`, `stop_old`, `prune`.

Rollback steps: `determine_active`, `assert_other_exists`, `nginx_write`, `nginx_reload`,
`verify_live`, `write_active_marker`.
