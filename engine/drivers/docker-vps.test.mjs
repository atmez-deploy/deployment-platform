// Unit tests for the compose-based docker-vps blue/green plan. Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { planDeploy, planRollback } from "./docker-vps.mjs";

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
    volumes: ["/opt/acadlynk/shared/uploads:/app/uploads"],
    healthPath: "/health",
  },
  {
    name: "web",
    image: "ghcr.io/org/acadlynk-web:abc123",
    containerPort: 80,
    hostPortBlue: 8095,
    hostPortGreen: 8096,
    domain: "acadlynk.com",
    ssl: true,
  },
  {
    name: "admin",
    role: "admin",
    image: "ghcr.io/org/acadlynk-admin:abc123",
    containerPort: 80,
    hostPortBlue: 8091,
    hostPortGreen: 8094,
    domain: "admin.acadlynk.com",
    ssl: true,
  },
];

const base = { project: "acadlynk", environment: "production", services };

test("deploy plan has the compose blue/green sequence", () => {
  const types = planDeploy(base).steps.map((s) => s.type);
  assert.deepEqual(types, [
    "determine_active",
    "ensure_dirs",
    "ensure_network",
    "write_env",
    "write_compose",
    "compose_pull_idle",
    "compose_up_idle",
    "health_check_idle",
    "nginx_write",
    "nginx_reload",
    "certbot",
    "verify_live",
    "write_active_marker",
  ]);
});

test("db enabled inserts write_file + compose_up before app", () => {
  const types = planDeploy({ ...base, db: { enabled: true, hostPort: 5433 } }).steps.map((s) => s.type);
  assert.ok(types.indexOf("compose_up") < types.indexOf("compose_up_idle"));
});

test("migration inserted after compose_up_idle, before health check", () => {
  const types = planDeploy({ ...base, migrate: { service: "backend", command: "npm run migrate" } }).steps.map((s) => s.type);
  assert.ok(types.indexOf("migrate") > types.indexOf("compose_up_idle"));
  assert.ok(types.indexOf("migrate") < types.indexOf("health_check_idle"));
});

test("write_compose carries both colors' compose text with correct ports", () => {
  const step = planDeploy(base).steps.find((s) => s.type === "write_compose");
  assert.match(step.blueContent, /"127\.0\.0\.1:5001:3000"/);
  assert.match(step.greenContent, /"127\.0\.0\.1:5002:3000"/);
});

test("nginx content includes admin /api -> backend port and uploads alias", () => {
  const step = planDeploy(base).steps.find((s) => s.type === "nginx_write");
  assert.match(step.blueContent, /set \$backend_port 5001;/);
  assert.match(step.blueContent, /location \/uploads\/ \{/);
});

test("certbot step only present when a service requests ssl:true", () => {
  const noSsl = planDeploy({ ...base, services: services.map((s) => ({ ...s, ssl: false })) });
  assert.ok(!noSsl.steps.some((s) => s.type === "certbot"));
});

test("verify_live marks ssl per service (https vs http)", () => {
  const step = planDeploy(base).steps.find((s) => s.type === "verify_live");
  assert.ok(step.checks.every((c) => c.ssl === true));
});

test("rejects a malformed image ref", () => {
  assert.throws(() => planDeploy({ ...base, services: [{ ...services[0], image: "bad ref" }] }), /invalid image reference/);
});

test("rollback repoints nginx to the other color, no compose up", () => {
  const types = planRollback(base).steps.map((s) => s.type);
  assert.deepEqual(types, ["determine_active", "assert_other_up", "nginx_write", "nginx_reload", "verify_live", "write_active_marker"]);
});
