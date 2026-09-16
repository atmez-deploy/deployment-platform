// Unit tests for compose-based docker-vps -> command compilation. Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";

import { planDeploy, planRollback } from "./drivers/docker-vps.mjs";
import { toCommands, renderCommands } from "./executor.mjs";

const conn = { host: "10.0.0.5", port: 22, username: "platform" };
const services = [
  {
    name: "backend",
    image: "ghcr.io/org/acadlynk-backend:abc123",
    containerPort: 3000,
    hostPortBlue: 5001,
    hostPortGreen: 5002,
    domain: "api.acadlynk.com",
    ssl: true,
    envFromSecret: "BACKEND_ENV",
    healthPath: "/health",
  },
  { name: "web", image: "ghcr.io/org/acadlynk-web:abc123", containerPort: 80, hostPortBlue: 8095, hostPortGreen: 8096, domain: "acadlynk.com", ssl: true },
];
const base = { project: "acadlynk", environment: "production", services };

test("deploy compiles to ssh-wrapped compose/nginx/certbot commands", () => {
  const cmds = toCommands(planDeploy(base), conn, { keyPath: "/tmp/k" });
  assert.ok(cmds.every((c) => c.bin === "ssh"));
  const joined = cmds.map((c) => c.args.at(-1)).join("\n");
  assert.match(joined, /docker network inspect 'acadlynk-production-network'/);
  assert.match(joined, /docker compose -f 'e?\/?opt\/acadlynk\/'?\$IDLE\/docker-compose\.app\.yml pull|docker compose -f '\/opt\/acadlynk'\/\$IDLE/);
  assert.match(joined, /docker compose .*\$IDLE\/docker-compose\.app\.yml up -d/);
  assert.match(joined, /certbot --nginx/);
});

test("write_env streams the secret from an env var, not a literal", () => {
  const cmds = toCommands(planDeploy(base), conn, { keyPath: "/tmp/k" });
  const env = cmds.find((c) => c.label.startsWith("write_env"));
  const cmd = env.args.at(-1);
  assert.match(cmd, /printf '%s' "\$BACKEND_ENV"/);
  assert.match(cmd, /chmod 600/);
});

test("nginx_write picks the idle color's config and symlinks enabled", () => {
  const cmds = toCommands(planDeploy(base), conn, { keyPath: "/tmp/k" });
  const nx = cmds.find((c) => c.label.startsWith("nginx_write"));
  const cmd = nx.args.at(-1);
  assert.match(cmd, /if \[ "\$IDLE" = blue \]/);
  assert.match(cmd, /ln -sfn '\/etc\/nginx\/sites-available\/acadlynk' '\/etc\/nginx\/sites-enabled\/acadlynk'/);
});

test("verify_live uses https for ssl services", () => {
  const cmds = toCommands(planDeploy(base), conn, { keyPath: "/tmp/k" });
  const v = cmds.find((c) => c.label.startsWith("verify_live"));
  assert.match(v.args.at(-1), /https:\/\/api\.acadlynk\.com/);
});

test("rollback compiles to nginx switch only (no compose up/pull)", () => {
  const cmds = toCommands(planRollback(base), conn, { keyPath: "/tmp/k" });
  const joined = cmds.map((c) => c.args.at(-1)).join("\n");
  assert.ok(!/compose .*up -d/.test(joined));
  assert.ok(!/compose .*pull/.test(joined));
  assert.match(joined, /nginx -t/);
});

test("dry-run render contains no key material", () => {
  const rendered = renderCommands(toCommands(planDeploy(base), conn, { keyPath: "/tmp/k" }));
  assert.ok(!rendered.includes("BEGIN OPENSSH PRIVATE KEY"));
  assert.ok(rendered.includes("/tmp/k"));
});
