// Unit tests for docker-vps -> command compilation. Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";

import { planDeploy, planRollback } from "./drivers/docker-vps.mjs";
import { toCommands, renderCommands } from "./executor.mjs";

const conn = { host: "10.0.0.5", port: 22, username: "platform" };
const base = {
  project: "example-app",
  environment: "staging",
  service: "backend",
  image: "ghcr.io/example-org/example-app-backend:abc123",
  port: 5001,
  domain: "api.staging.example.com",
  health: { path: "/api/health", expect_status: 200, retries: 3, timeout_seconds: 10 },
};

test("deploy compiles to ssh-wrapped docker commands", () => {
  const cmds = toCommands(planDeploy(base), conn, { keyPath: "/tmp/k" });
  assert.ok(cmds.every((c) => c.bin === "ssh"));
  const joined = cmds.map((c) => c.args.at(-1)).join("\n");
  assert.match(joined, /docker network inspect .*example-app-staging-network/);
  assert.match(joined, /docker pull 'ghcr\.io\/example-org\/example-app-backend:abc123'/);
  assert.match(joined, /docker run -d --name example-app-staging-backend-\$IDLE/);
  assert.match(joined, /-p 127\.0\.0\.1:5001:5001/);
});

test("health check probes the container port with retry loop", () => {
  const cmds = toCommands(planDeploy(base), conn, { keyPath: "/tmp/k" });
  const health = cmds.find((c) => c.label.startsWith("health_check"));
  const cmd = health.args.at(-1);
  assert.match(cmd, /seq 1 4/); // retries 3 => 4 attempts
  assert.match(cmd, /127\.0\.0\.1:5001\/api\/health/);
  assert.match(cmd, /"200"/);
});

test("nginx_write uses a heredoc containing the rendered config", () => {
  const cmds = toCommands(planDeploy(base), conn, { keyPath: "/tmp/k" });
  const write = cmds.find((c) => c.label.startsWith("nginx_write"));
  const cmd = write.args.at(-1);
  assert.match(cmd, /cat > '\/etc\/nginx\/sites-enabled\/example-app-staging-backend\.conf'/);
  assert.match(cmd, /server 127\.0\.0\.1:5001;/);
});

test("stop_old stops the color opposite the (already-updated) marker", () => {
  const cmds = toCommands(planDeploy(base), conn, { keyPath: "/tmp/k" });
  const stop = cmds.find((c) => c.label.startsWith("stop_old"));
  const cmd = stop.args.at(-1);
  // must derive OLD from the marker, not blindly stop a fixed color
  assert.match(cmd, /OLD=green/);
  assert.match(cmd, /OLD=blue/);
  assert.match(cmd, /docker stop example-app-staging-backend-\$OLD/);
});

test("rollback compiles to nginx switch commands only (no docker run/pull)", () => {
  const cmds = toCommands(planRollback(base), conn, { keyPath: "/tmp/k" });
  const joined = cmds.map((c) => c.args.at(-1)).join("\n");
  assert.ok(!/docker pull/.test(joined));
  assert.ok(!/docker run/.test(joined));
  assert.match(joined, /nginx -t/);
});

test("dry-run render contains no key material", () => {
  const rendered = renderCommands(toCommands(planDeploy(base), conn, { keyPath: "/tmp/k" }));
  assert.ok(!rendered.includes("BEGIN OPENSSH PRIVATE KEY"));
  assert.ok(rendered.includes("/tmp/k"));
});
