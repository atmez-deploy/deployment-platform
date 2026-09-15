// Unit tests for the hostinger static publisher plan generation. Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";

import { planDeploy, planRollback } from "./static-hostinger.mjs";

const sshConn = {
  host: "1.2.3.4",
  port: 65002,
  username: "u123",
  webroot: "public_html",
  auth: "ssh_key",
  transfer: "rsync",
};

const ftpsConn = {
  host: "1.2.3.4",
  username: "u123",
  webroot: "public_html",
  auth: "ftps",
  transfer: "ftps",
};

test("ssh deploy plan uploads to releases/<sha> then swaps current", () => {
  const plan = planDeploy({ connection: sshConn, sha: "abc123", localDir: "dist" });
  assert.equal(plan.mode, "ssh-release");
  const types = plan.steps.map((s) => s.type);
  assert.deepEqual(types, ["ensure_dir", "upload", "symlink_swap", "verify", "prune_releases"]);

  const upload = plan.steps.find((s) => s.type === "upload");
  assert.equal(upload.remoteDir, "public_html/releases/abc123");
  assert.equal(upload.method, "rsync");

  const swap = plan.steps.find((s) => s.type === "symlink_swap");
  assert.equal(swap.link, "public_html/current");
  assert.equal(swap.target, "public_html/releases/abc123");
});

test("deploy plan is deterministic for identical inputs", () => {
  const a = planDeploy({ connection: sshConn, sha: "abc123", localDir: "dist" });
  const b = planDeploy({ connection: sshConn, sha: "abc123", localDir: "dist" });
  assert.deepEqual(a, b);
});

test("prune step carries the retention window", () => {
  const plan = planDeploy({ connection: sshConn, sha: "abc123", localDir: "dist", keepReleases: 3 });
  const prune = plan.steps.find((s) => s.type === "prune_releases");
  assert.equal(prune.keep, 3);
  assert.equal(prune.releasesRoot, "public_html/releases");
});

test("ftps deploy plan mirrors into webroot, no symlink", () => {
  const plan = planDeploy({ connection: ftpsConn, sha: "abc123", localDir: "dist" });
  assert.equal(plan.mode, "ftps-mirror");
  const types = plan.steps.map((s) => s.type);
  assert.deepEqual(types, ["upload"]);
  assert.equal(plan.steps[0].remoteDir, "public_html");
  assert.equal(plan.steps[0].mirror, true);
});

test("invalid sha is rejected (injection guard)", () => {
  assert.throws(() => planDeploy({ connection: sshConn, sha: "../evil", localDir: "dist" }), /invalid release id/);
  assert.throws(() => planDeploy({ connection: sshConn, sha: "a b; rm -rf /", localDir: "dist" }), /invalid release id/);
});

test("missing localDir / webroot is rejected", () => {
  assert.throws(() => planDeploy({ connection: sshConn, sha: "abc", localDir: "" }), /localDir is required/);
  assert.throws(
    () => planDeploy({ connection: { ...sshConn, webroot: undefined }, sha: "abc", localDir: "dist" }),
    /webroot is required/,
  );
});

test("ssh rollback plan verifies then repoints current", () => {
  const plan = planRollback({ connection: sshConn, toSha: "old999" });
  const types = plan.steps.map((s) => s.type);
  assert.deepEqual(types, ["verify", "symlink_swap"]);
  assert.equal(plan.steps[1].target, "public_html/releases/old999");
});

test("ftps rollback is rejected (no symlink on FTPS)", () => {
  assert.throws(() => planRollback({ connection: ftpsConn, toSha: "old999" }), /requires ssh_key/);
});
