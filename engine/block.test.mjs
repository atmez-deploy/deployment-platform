// Unit tests for port-block allocation. Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { allocateBlock, portsForBlock, usedBlockBases, blockConfig } from "./registry.mjs";
import { BlockExhaustedError } from "./errors.mjs";

function vps(projects = []) {
  return {
    id: "vps-01",
    kind: "vps",
    connection: { host: "h", username: "u", ssh_key_ref: "k" },
    port_block: { start: 5000, end: 5149, size: 50 }, // room for 3 blocks
    projects,
  };
}

test("blockConfig returns defaults when unset", () => {
  const cfg = blockConfig({ id: "x", kind: "vps" });
  assert.equal(cfg.size, 50);
});

test("first project gets the start block", () => {
  assert.equal(allocateBlock(vps()), 5000);
});

test("next project gets the next non-overlapping block", () => {
  const v = vps([{ project: "a", environment: "prod", block_base: 5000 }]);
  assert.equal(allocateBlock(v), 5050);
});

test("skips already-used blocks regardless of order", () => {
  const v = vps([
    { project: "a", environment: "prod", block_base: 5000 },
    { project: "b", environment: "prod", block_base: 5100 },
  ]);
  assert.equal(allocateBlock(v), 5050); // 5050 is the free one in the middle
});

test("throws when no block is free", () => {
  const v = vps([
    { project: "a", environment: "prod", block_base: 5000 },
    { project: "b", environment: "prod", block_base: 5050 },
    { project: "c", environment: "prod", block_base: 5100 },
  ]);
  assert.throws(() => allocateBlock(v), BlockExhaustedError);
});

test("portsForBlock gives non-conflicting blue/green per service", () => {
  const ports = portsForBlock(5000, 50, ["backend", "web", "admin"]);
  assert.deepEqual(ports.backend, { blue: 5000, green: 5025 });
  assert.deepEqual(ports.web, { blue: 5001, green: 5026 });
  assert.deepEqual(ports.admin, { blue: 5002, green: 5027 });
  // no blue equals any green
  const blues = Object.values(ports).map((p) => p.blue);
  const greens = Object.values(ports).map((p) => p.green);
  assert.ok(blues.every((b) => !greens.includes(b)));
});

test("two different projects' blocks never overlap", () => {
  const a = portsForBlock(5000, 50, ["backend", "web"]);
  const b = portsForBlock(5050, 50, ["backend", "web"]);
  const aAll = Object.values(a).flatMap((p) => [p.blue, p.green]);
  const bAll = Object.values(b).flatMap((p) => [p.blue, p.green]);
  assert.ok(aAll.every((p) => !bAll.includes(p)));
});

test("rejects too many services for the half-block", () => {
  assert.throws(() => portsForBlock(5000, 4, ["a", "b", "c"]), /too many services/);
});
