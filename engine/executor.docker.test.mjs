// Unit tests for deploy-backend.sh-aligned docker-vps command compilation. Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";

import { planDeploy, planRollback } from "./drivers/docker-vps.mjs";
import { toCommands, renderCommands } from "./executor.mjs";

const conn = { host: "10.0.0.5", port: 22, username: "platform" };
const services = [
  { name: "backend", image: "ghcr.io/org/acadlynk-backend:abc123", containerPort: 3000, hostPortBlue: 5001, hostPortGreen: 5002, domain: "api.acadlynk.com", ssl: true, envFromSecret: "BACKEND_ENV" },
  { name: "web", image: "ghcr.io/org/acadlynk-web:abc123", containerPort: 80, hostPortBlue: 8095, hostPortGreen: 8096, domain: "acadlynk.com", ssl: true },
];
const base = { project: "acadlynk", environment: "production", services };

test("compose uses -p <project>-$TARGET and --force-recreate", () => {
  const cmds = toCommands(planDeploy(base), conn, { keyPath: "/tmp/k" });
  const joined = cmds.map((c) => c.args.at(-1)).join("\n");
  assert.match(joined, /docker compose -p acadlynk-\$TARGET -f .*\/\$TARGET\/docker-compose\.app\.yml pull/);
  assert.match(joined, /up -d --force-recreate/);
});

test("TARGET/OLD derived from active_env like the script", () => {
  const cmds = toCommands(planDeploy(base), conn, { keyPath: "/tmp/k" });
  const det = cmds.find((c) => c.label.startsWith("determine_active"));
  assert.match(det.args.at(-1), /if \[ "\$ACTIVE" = blue \]; then TARGET=green; OLD=blue/);
});

test("health check uses curl -fs with 20 retries and the backend /api/health path", () => {
  const cmds = toCommands(planDeploy(base), conn, { keyPath: "/tmp/k" });
  const hc = cmds.find((c) => c.label.startsWith("health_check_target"));
  const cmd = hc.args.at(-1);
  assert.match(cmd, /curl -fs http:\/\/localhost:\$P\/api\/health/);
  assert.match(cmd, /seq 1 20/);
});

test("switch is a sed of set $<svc>_port in the EXISTING conf (preserves SSL)", () => {
  const cmds = toCommands(planDeploy(base), conn, { keyPath: "/tmp/k" });
  const sw = cmds.find((c) => c.label.startsWith("switch_ports"));
  const cmd = sw.args.at(-1);
  assert.match(cmd, /sed -i "s\/set \\\$backend_port \.\*\/set \\\$backend_port .*;\/" '\/etc\/nginx\/sites-available\/acadlynk'/);
  // must NOT rewrite the whole file
  assert.ok(!/cat > .*sites-available\/acadlynk <</.test(cmd));
});

test("bootstrap only writes conf + certbot when the file is missing", () => {
  const cmds = toCommands(planDeploy(base), conn, { keyPath: "/tmp/k" });
  const bs = cmds.find((c) => c.label.startsWith("bootstrap_nginx_if_missing"));
  const cmd = bs.args.at(-1);
  assert.match(cmd, /if \[ ! -f '\/etc\/nginx\/sites-available\/acadlynk' \]/);
  assert.match(cmd, /certbot --nginx/);
  assert.match(cmd, /preserving \(SSL kept\)/);
});

test("old color brought down after switch", () => {
  const cmds = toCommands(planDeploy(base), conn, { keyPath: "/tmp/k" });
  const down = cmds.find((c) => c.label.startsWith("compose_down_old"));
  assert.match(down.args.at(-1), /docker compose -p acadlynk-\$OLD .* down/);
});

test("verify_live uses https for ssl services", () => {
  const cmds = toCommands(planDeploy(base), conn, { keyPath: "/tmp/k" });
  const v = cmds.find((c) => c.label.startsWith("verify_live"));
  assert.match(v.args.at(-1), /curl -fsk https:\/\/api\.acadlynk\.com\/api\/health/);
});

test("rollback ups old color + sed switches back, no compose down", () => {
  const cmds = toCommands(planRollback(base), conn, { keyPath: "/tmp/k" });
  const joined = cmds.map((c) => c.args.at(-1)).join("\n");
  assert.match(joined, /docker compose -p acadlynk-\$OLD .* up -d/);
  assert.match(joined, /sed -i "s\/set \\\$backend_port/);
  assert.ok(!/ down$/m.test(joined.replace(/up -d/g, "")));
});

test("dry-run render contains no key material", () => {
  const rendered = renderCommands(toCommands(planDeploy(base), conn, { keyPath: "/tmp/k" }));
  assert.ok(!rendered.includes("BEGIN OPENSSH PRIVATE KEY"));
  assert.ok(rendered.includes("/tmp/k"));
});
