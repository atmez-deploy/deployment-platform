// Unit tests for the deploy-backend.sh-aligned docker-vps plan. Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { planDeploy, planRollback } from "./docker-vps.mjs";

const services = [
  { name: "backend", image: "ghcr.io/org/acadlynk-backend:abc123", containerPort: 3000, hostPortBlue: 5001, hostPortGreen: 5002, domain: "api.acadlynk.com", ssl: true, envFromSecret: "BACKEND_ENV", volumes: ["/opt/acadlynk/shared/uploads:/app/uploads"] },
  { name: "web", image: "ghcr.io/org/acadlynk-web:abc123", containerPort: 80, hostPortBlue: 8095, hostPortGreen: 8096, domain: "acadlynk.com", ssl: true },
  { name: "admin", role: "admin", image: "ghcr.io/org/acadlynk-admin:abc123", containerPort: 80, hostPortBlue: 8091, hostPortGreen: 8094, domain: "admin.acadlynk.com", ssl: true },
];
const base = { project: "acadlynk", environment: "production", services };

test("deploy plan follows the deploy-backend.sh sequence", () => {
  const types = planDeploy(base).steps.map((s) => s.type);
  assert.deepEqual(types, [
    "determine_active",
    "ensure_dirs",
    "ensure_network",
    "write_env",
    "write_compose",
    "compose_pull_target",
    "compose_up_target",
    "health_check_target",
    "bootstrap_nginx_if_missing",
    "switch_ports",
    "nginx_reload",
    "write_active_marker",
    "verify_live",
    "compose_down_old",
  ]);
});

test("switch_ports carries per-service port vars for both colors", () => {
  const step = planDeploy(base).steps.find((s) => s.type === "switch_ports");
  const backend = step.portVars.find((p) => p.var === "backend_port");
  assert.deepEqual({ blue: backend.blue, green: backend.green }, { blue: 5001, green: 5002 });
  assert.equal(step.portVars.length, 3);
});

test("health check uses /api/health for backend and / for others", () => {
  const step = planDeploy(base).steps.find((s) => s.type === "health_check_target");
  const byName = Object.fromEntries(step.services.map((s) => [s.name, s.path]));
  assert.equal(byName.backend, "/api/health");
  assert.equal(byName.web, "/");
});

test("bootstrap step carries ssl domains for first-time certbot", () => {
  const step = planDeploy(base).steps.find((s) => s.type === "bootstrap_nginx_if_missing");
  assert.deepEqual(step.sslDomains.sort(), ["acadlynk.com", "admin.acadlynk.com", "api.acadlynk.com"].sort());
});

test("db enabled inserts write_file + compose_up before app", () => {
  const types = planDeploy({ ...base, db: { enabled: true, hostPort: 5433 } }).steps.map((s) => s.type);
  assert.ok(types.indexOf("compose_up") < types.indexOf("compose_up_target"));
});

test("migration runs after compose_up_target, before health check", () => {
  const types = planDeploy({ ...base, migrate: { service: "backend", command: "npm run migrate" } }).steps.map((s) => s.type);
  assert.ok(types.indexOf("migrate") > types.indexOf("compose_up_target"));
  assert.ok(types.indexOf("migrate") < types.indexOf("health_check_target"));
});

test("rejects a malformed image ref", () => {
  assert.throws(() => planDeploy({ ...base, services: [{ ...services[0], image: "bad ref" }] }), /invalid image reference/);
});

test("rollback brings previous color up, sed-switches ports back, no down", () => {
  const types = planRollback(base).steps.map((s) => s.type);
  assert.deepEqual(types, ["determine_active", "compose_up_old", "switch_ports", "nginx_reload", "write_active_marker_old", "verify_live"]);
  const sp = planRollback(base).steps.find((s) => s.type === "switch_ports");
  assert.equal(sp.portVars[0].color, "old");
});
