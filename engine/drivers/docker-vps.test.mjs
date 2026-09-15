// Unit tests for the docker-vps blue/green plan generation. Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { planDeploy, planRollback } from "./docker-vps.mjs";
import { otherColor, containerName, networkName } from "../naming.mjs";

const base = {
  project: "example-app",
  environment: "staging",
  service: "backend",
  image: "ghcr.io/example-org/example-app-backend:abc123",
  port: 5001,
  domain: "api.staging.example.com",
  health: { path: "/api/health", expect_status: 200 },
};

test("naming helpers derive isolated names", () => {
  assert.equal(otherColor("blue"), "green");
  assert.equal(otherColor("green"), "blue");
  assert.equal(containerName("p", "e", "s", "blue"), "p-e-s-blue");
  assert.equal(networkName("p", "e"), "p-e-network");
});

test("deploy plan has the blue/green step sequence in order", () => {
  const plan = planDeploy(base);
  const types = plan.steps.map((s) => s.type);
  assert.deepEqual(types, [
    "determine_active",
    "ensure_network",
    "pull",
    "run_container",
    "health_check",
    "nginx_write",
    "nginx_reload",
    "verify_live",
    "write_active_marker",
    "stop_old",
  ]);
});

test("migration step is inserted before health_check when configured", () => {
  const plan = planDeploy({ ...base, migrate: { command: "npm run migrate" } });
  const types = plan.steps.map((s) => s.type);
  const migrateIdx = types.indexOf("migrate");
  const healthIdx = types.indexOf("health_check");
  assert.ok(migrateIdx !== -1 && migrateIdx < healthIdx);
});

test("nginx_write content targets the allocated port and upstream", () => {
  const plan = planDeploy(base);
  const write = plan.steps.find((s) => s.type === "nginx_write");
  assert.match(write.content, /server 127\.0\.0\.1:5001;/);
  assert.equal(plan.identity.upstreamName, "example-app-staging-backend");
  assert.match(write.confPath, /example-app-staging-backend\.conf$/);
});

test("deploy plan is deterministic", () => {
  assert.deepEqual(planDeploy(base), planDeploy(base));
});

test("rejects a non-immutable / malformed image ref", () => {
  assert.throws(() => planDeploy({ ...base, image: "not a ref!!" }), /invalid image reference/);
});

test("rollback plan switches back via nginx without touching containers", () => {
  const plan = planRollback(base);
  const types = plan.steps.map((s) => s.type);
  assert.deepEqual(types, [
    "determine_active",
    "assert_other_exists",
    "nginx_write",
    "nginx_reload",
    "verify_live",
    "write_active_marker",
  ]);
  // no pull/run/stop in rollback
  assert.ok(!types.includes("pull"));
  assert.ok(!types.includes("stop_old"));
});
