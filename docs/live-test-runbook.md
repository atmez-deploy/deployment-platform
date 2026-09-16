# Live Test Runbook — school VPS (safe, isolated from acadlynk)

Goal: prove the VPS pipeline end-to-end on the real `school` box **without touching the
live acadlynk deployment**. We deploy a throwaway `hello-test` service on its own port
block, network, nginx file, and test subdomain, then clean it up completely.

## Why this is safe (isolation)

`hello-test` shares nothing with acadlynk:

| Resource        | acadlynk (live)                | hello-test (this test)          |
|-----------------|--------------------------------|---------------------------------|
| Ports           | 5000-5099, 8091-8096           | **9000 / 9025** (block 9000+)   |
| Docker network  | acadlynk_network               | hello-test-staging-network      |
| Containers      | acadlynk-{blue,green}-*        | hello-test-{blue,green}-web-1   |
| Nginx conf      | /etc/nginx/sites-*/acadlynk    | /etc/nginx/sites-*/hello-test   |
| Dirs            | /opt/acadlynk                  | /opt/hello-test                 |
| Domain          | *.acadlynk.com                 | hello-test.acadlynk.com         |
| active_env      | /opt/acadlynk/active_env       | /opt/hello-test/active_env      |

Nothing the test does writes to any acadlynk path, container, network, port, or its nginx
file. The image is a public `nginxdemos/hello` (no build/registry needed).

## Prerequisites (one-time)

1. **Fill in the school VPS entry** in `config/registry.example.yaml` (the `school` entry):
   set `connection.host` to the VPS IP and `connection.username` to a deploy user that can
   run `docker` and reload nginx.
2. **DEPLOY_SSH_KEY secret** in the repo: the private key for that deploy user.
3. **Test subdomain**: point `hello-test.acadlynk.com` (A record) at the VPS IP. Needed for
   the SSL step + live https verify. (If you skip DNS, run without SSL — see note below.)

## Step 1 — Register (allocate the block)

Dry run first (writes nothing):
```
node engine/cli.mjs register --config examples/hello-test.project.yaml --env staging \
  --registry config/registry.example.yaml
```
Expect: `block_base: 9000`, web blue=9000 green=9025. Then persist:
```
node engine/cli.mjs register ... --execute
```
Or run the **Register project** workflow with config `examples/hello-test.project.yaml`,
environment `staging`, execute `true`.

## Step 2 — Deploy (dry run, then live)

Dry run — prints the exact ssh/docker/nginx/certbot commands, touches nothing:
```
node engine/cli.mjs deploy-service --config examples/hello-test.project.yaml \
  --env staging --registry config/registry.example.yaml \
  --image web=nginxdemos/hello:latest
```
Read it and confirm every path/port is `hello-test` / `9000` — never `acadlynk`.

Live — via the **Deploy (select platform)** or **Deploy service** workflow with
`confirm: true` (needs DEPLOY_SSH_KEY). It will:
ensure dirs/network → write compose → pull → up (idle color) → health check on :9000 →
bootstrap nginx (hello-test.conf) → certbot for hello-test.acadlynk.com → switch → verify
`https://hello-test.acadlynk.com` → bring old color down.

Verify: open `https://hello-test.acadlynk.com` — you should see the nginx "hello" page.

> No DNS/SSL? Temporarily set the service `ssl: false` in the config; verify hits the
> container port over http instead. The rest of the flow is identical.

## Step 3 — Rollback (prove reversibility)

Run the **Rollback service** flow (or `rollback-service`) with `confirm: true`. It brings
the previous color up and flips nginx back. For a first deploy there's no prior color, so
rollback is only meaningful after a second deploy — do two deploys, then roll back.

## Step 4 — Cleanup (leave the VPS exactly as before)

SSH to the VPS and remove only the hello-test resources:
```
docker compose -p hello-test-blue  -f /opt/hello-test/blue/docker-compose.app.yml  down 2>/dev/null || true
docker compose -p hello-test-green -f /opt/hello-test/green/docker-compose.app.yml down 2>/dev/null || true
docker network rm hello-test-staging-network 2>/dev/null || true
sudo rm -f /etc/nginx/sites-enabled/hello-test /etc/nginx/sites-available/hello-test
sudo nginx -t && sudo systemctl reload nginx
sudo rm -rf /opt/hello-test
# optional: remove the cert
sudo certbot delete --cert-name hello-test.acadlynk.com 2>/dev/null || true
```
Then remove the `hello-test` project entry from `config/registry.example.yaml` (and the
test subdomain DNS record if you want).

## Confirm acadlynk is untouched

```
cat /opt/acadlynk/active_env            # unchanged
docker ps | grep acadlynk               # same containers running
curl -fsI https://acadlynk.com          # still 200
ls /etc/nginx/sites-enabled/            # acadlynk conf intact
```

If all four are as before, the test proved the pipeline on real infrastructure with zero
impact on production.
