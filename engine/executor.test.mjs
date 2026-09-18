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

test("ssh deploy compiles to ensure_dir + rsync mirror + verify", () => {
  const plan = planDeploy({ connection: conn, sha: "abc123", localDir: "dist" });
  const cmds = toCommands(plan, conn, { keyPath: "/tmp/key" });
  const bins = cmds.map((c) => c.bin);
  assert.deepEqual(bins, ["ssh", "rsync", "ssh"]);

  const rsync = cmds.find((c) => c.bin === "rsync");
  assert.ok(rsync.args.includes("--delete"));
  // mirrors straight into the webroot, NOT a releases/<sha> subdir
  assert.ok(rsync.args.some((a) => a.endsWith("public_html/")));
  assert.ok(!rsync.args.some((a) => a.includes("releases/")));
  assert.ok(rsync.args.some((a) => a.includes("-i /tmp/key")));
});

test("commands never contain the private key material (only the path)", () => {
  const plan = planDeploy({ connection: conn, sha: "abc123", localDir: "dist" });
  const rendered = renderCommands(toCommands(plan, conn, { keyPath: "/tmp/key" }));
  assert.ok(!rendered.includes("BEGIN OPENSSH PRIVATE KEY"));
  assert.ok(rendered.includes("/tmp/key")); // path is fine
});

test("runPlan without execute returns a dry run (no network)", () => {
  const plan = planDeploy({ connection: conn, sha: "abc123", localDir: "dist" });
  const res = runPlan(plan, conn, { keyPath: "/tmp/key" });
  assert.equal(res.dryRun, true);
  assert.equal(res.ok, true);
  assert.ok(Array.isArray(res.commands));
});

// --- FTPS path ---
const ftpsConn = {
  host: "ftp.example.com",
  port: 21,
  username: "u123",
  webroot: "public_html",
  auth: "ftps",
  transfer: "ftps",
};

test("ftps deploy compiles to an lftp mirror referencing $FTP_PASSWORD (never a literal)", () => {
  const plan = planDeploy({ connection: ftpsConn, sha: "abc123", localDir: "dist" });
  const cmds = toCommands(plan, ftpsConn);
  assert.equal(cmds.length, 1);
  assert.equal(cmds[0].bin, "lftp");
  const script = cmds[0].args.at(-1);
  assert.match(script, /open -u u123,\$FTP_PASSWORD ftp\.example\.com/);
  assert.match(script, /mirror -R --delete dist public_html/);
  // the password must be an env reference, not a value
  assert.ok(!/password123|secret/i.test(script));
});
