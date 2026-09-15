// Unit tests for the executor's pure command generation. Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";

import { planDeploy, planRollback } from "./drivers/static-hostinger.mjs";
import { toCommands, renderCommands, runPlan } from "./executor.mjs";

const conn = {
  host: "1.2.3.4",
  port: 65002,
  username: "u123",
  webroot: "public_html",
  auth: "ssh_key",
  transfer: "rsync",
};

test("deploy plan compiles to ssh/rsync commands in order", () => {
  const plan = planDeploy({ connection: conn, sha: "abc123", localDir: "dist" });
  const cmds = toCommands(plan, conn, { keyPath: "/tmp/key" });
  const bins = cmds.map((c) => c.bin);
  assert.deepEqual(bins, ["ssh", "rsync", "ssh", "ssh", "ssh"]);

  const rsync = cmds.find((c) => c.bin === "rsync");
  assert.ok(rsync.args.includes("--delete"));
  assert.ok(rsync.args.some((a) => a.endsWith("public_html/releases/abc123/")));
  // ssh identity is passed via -e string to rsync
  assert.ok(rsync.args.some((a) => a.includes("-i /tmp/key")));
});

test("symlink swap is atomic (temp link then mv -T)", () => {
  const plan = planDeploy({ connection: conn, sha: "abc123", localDir: "dist" });
  const cmds = toCommands(plan, conn, { keyPath: "/tmp/key" });
  const swap = cmds.find((c) => c.label.startsWith("symlink_swap"));
  const remote = swap.args[swap.args.length - 1];
  assert.match(remote, /ln -sfn/);
  assert.match(remote, /mv -T/);
});

test("commands never contain the private key material (only the path)", () => {
  const plan = planDeploy({ connection: conn, sha: "abc123", localDir: "dist" });
  const rendered = renderCommands(toCommands(plan, conn, { keyPath: "/tmp/key" }));
  assert.ok(!rendered.includes("BEGIN OPENSSH PRIVATE KEY"));
  assert.ok(rendered.includes("/tmp/key")); // path is fine
});

test("runPlan without execute returns a dry run (no network)", () => {
  const plan = planRollback({ connection: conn, toSha: "old999" });
  const res = runPlan(plan, conn, { keyPath: "/tmp/key" });
  assert.equal(res.dryRun, true);
  assert.equal(res.ok, true);
  assert.ok(Array.isArray(res.commands));
});

test("prune command keeps N newest release dirs", () => {
  const plan = planDeploy({ connection: conn, sha: "abc123", localDir: "dist", keepReleases: 4 });
  const cmds = toCommands(plan, conn, { keyPath: "/tmp/key" });
  const prune = cmds.find((c) => c.label.startsWith("prune_releases"));
  const remote = prune.args[prune.args.length - 1];
  assert.match(remote, /tail -n \+5/); // keep 4 => delete from line 5 on
});
