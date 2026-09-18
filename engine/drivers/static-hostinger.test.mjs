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

test("ssh deploy MIRRORS straight into the webroot (shared hosting serves it directly)", () => {
  const plan = planDeploy({ connection: sshConn, sha: "abc123", localDir: "dist" });
  assert.equal(plan.mode, "ssh-mirror");
  const types = plan.steps.map((s) => s.type);
  assert.deepEqual(types, ["ensure_dir", "upload", "verify"]);

  const upload = plan.steps.find((s) => s.type === "upload");
  assert.equal(upload.remoteDir, "public_html"); // NOT releases/<sha>
  assert.equal(upload.method, "rsync");
  assert.equal(upload.mirror, true);
});

test("deploy plan is deterministic for identical inputs", () => {
  const a = planDeploy({ connection: sshConn, sha: "abc123", localDir: "dist" });
  const b = planDeploy({ connection: sshConn, sha: "abc123", localDir: "dist" });
  assert.deepEqual(a, b);
});

test("verify checks index.html landed in the webroot", () => {
  const plan = planDeploy({ connection: sshConn, sha: "abc123", localDir: "dist" });
  const v = plan.steps.find((s) => s.type === "verify");
  assert.equal(v.path, "public_html/index.html");
});

test("ftps deploy plan mirrors into webroot", () => {
  const plan = planDeploy({ connection: ftpsConn, sha: "abc123", localDir: "dist" });
  assert.equal(plan.mode, "ftps-mirror");
  const types = plan.steps.map((s) => s.type);
  assert.deepEqual(types, ["upload"]);
  assert.equal(plan.steps[0].remoteDir, "public_html");
  assert.equal(plan.steps[0].mirror, true);
});

test("sha is optional now, but a malformed one is still rejected", () => {
  assert.doesNotThrow(() => planDeploy({ connection: sshConn, localDir: "dist" })); // no sha ok
  assert.throws(() => planDeploy({ connection: sshConn, sha: "a b; rm -rf /", localDir: "dist" }), /invalid release id/);
});

test("missing localDir / webroot is rejected", () => {
  assert.throws(() => planDeploy({ connection: sshConn, localDir: "" }), /localDir is required/);
  assert.throws(
    () => planDeploy({ connection: { ...sshConn, webroot: undefined }, localDir: "dist" }),
    /webroot is required/,
  );
});

test("rollback on shared hosting = redeploy (no atomic switch)", () => {
  assert.throws(() => planRollback(), /redeploy the previous build/);
});
