// Unit tests for the resource allocator. Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveTarget, usedPorts, usedDomains } from "./registry.mjs";
import {
  allocatePort,
  assertPortFree,
  allocateDomain,
  checkCollisions,
} from "./allocator.mjs";
import {
  UnknownTargetError,
  UnknownPoolError,
  PoolExhaustedError,
  DuplicateDomainError,
  DuplicatePortError,
  TargetKindError,
} from "./errors.mjs";

// Fresh fixture per test (allocator is pure but tests may mutate copies).
function registry() {
  return {
    schema_version: "1.0",
    resources: [
      {
        id: "vps-01",
        kind: "vps",
        connection: { host: "h", username: "u", ssh_key_ref: "k" },
        port_pools: {
          backend: { start: 5000, end: 5002 }, // small range to test exhaustion
          web: { start: 8100, end: 8199 },
        },
        projects: [
          {
            project: "example-app",
            environment: "staging",
            allocations: {
              ports: [{ service: "backend", port: 5000, pool: "backend" }],
              domains: [{ service: "web", domain: "Staging.Example.com" }],
            },
          },
        ],
      },
      { id: "hostinger-main", kind: "external", provider: "hostinger" },
    ],
  };
}

test("resolveTarget returns the matching entry", () => {
  const vps = resolveTarget(registry(), "vps-01");
  assert.equal(vps.id, "vps-01");
});

test("resolveTarget throws UnknownTargetError for missing ref", () => {
  assert.throws(() => resolveTarget(registry(), "nope"), UnknownTargetError);
});

test("usedPorts/usedDomains index existing allocations (domains lowercased)", () => {
  const vps = resolveTarget(registry(), "vps-01");
  assert.deepEqual([...usedPorts(vps)], [5000]);
  assert.ok(usedDomains(vps).has("staging.example.com"));
});

test("allocatePort returns the lowest free port, skipping taken ones", () => {
  const vps = resolveTarget(registry(), "vps-01");
  // 5000 is taken → next free is 5001
  assert.equal(allocatePort(vps, "backend"), 5001);
});

test("allocatePort is deterministic", () => {
  const vps = resolveTarget(registry(), "vps-01");
  assert.equal(allocatePort(vps, "backend"), allocatePort(vps, "backend"));
});

test("allocatePort throws PoolExhaustedError when range is full", () => {
  const reg = registry();
  const vps = resolveTarget(reg, "vps-01");
  // fill 5001 and 5002 (5000 already taken) → backend pool 5000..5002 exhausted
  vps.projects[0].allocations.ports.push(
    { service: "a", port: 5001, pool: "backend" },
    { service: "b", port: 5002, pool: "backend" },
  );
  assert.throws(() => allocatePort(vps, "backend"), PoolExhaustedError);
});

test("allocatePort throws UnknownPoolError for undefined pool", () => {
  const vps = resolveTarget(registry(), "vps-01");
  assert.throws(() => allocatePort(vps, "ghost"), UnknownPoolError);
});

test("port/pool ops on an external target throw TargetKindError", () => {
  const ext = resolveTarget(registry(), "hostinger-main");
  assert.throws(() => allocatePort(ext, "backend"), TargetKindError);
  assert.throws(() => assertPortFree(ext, 5005), TargetKindError);
  assert.throws(() => allocateDomain(ext, "x.com"), TargetKindError);
});

test("assertPortFree passes for a free port and throws for a taken one", () => {
  const vps = resolveTarget(registry(), "vps-01");
  assert.equal(assertPortFree(vps, 5001), 5001);
  assert.throws(() => assertPortFree(vps, 5000), DuplicatePortError);
});

test("allocateDomain normalizes and rejects duplicates (case-insensitive)", () => {
  const vps = resolveTarget(registry(), "vps-01");
  assert.equal(allocateDomain(vps, "New.Example.com"), "new.example.com");
  assert.throws(() => allocateDomain(vps, "STAGING.example.COM"), DuplicateDomainError);
});

test("checkCollisions rejects conflict with existing allocation", () => {
  const vps = resolveTarget(registry(), "vps-01");
  assert.throws(
    () => checkCollisions(vps, { ports: [{ port: 5000 }] }),
    DuplicatePortError,
  );
  assert.throws(
    () => checkCollisions(vps, { domains: [{ domain: "staging.example.com" }] }),
    DuplicateDomainError,
  );
});

test("checkCollisions rejects a request that duplicates itself", () => {
  const vps = resolveTarget(registry(), "vps-01");
  assert.throws(
    () => checkCollisions(vps, { ports: [{ port: 5005 }, { port: 5005 }] }),
    DuplicatePortError,
  );
  assert.throws(
    () => checkCollisions(vps, { domains: [{ domain: "a.com" }, { domain: "A.com" }] }),
    DuplicateDomainError,
  );
});

test("checkCollisions passes for a fully free allocation", () => {
  const vps = resolveTarget(registry(), "vps-01");
  assert.doesNotThrow(() =>
    checkCollisions(vps, {
      ports: [{ port: 5001 }],
      domains: [{ domain: "fresh.example.com" }],
    }),
  );
});
