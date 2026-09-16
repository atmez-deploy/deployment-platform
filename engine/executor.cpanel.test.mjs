// Unit tests for cPanel -> command compilation. Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { planDeploy } from "./drivers/cpanel.mjs";
import { toCommands, renderCommands } from "./executor.mjs";

const conn = {
  host: "server.example-host.com",
  port: 2083,
  username: "acctuser",
  apiTokenRef: "CPANEL_API_TOKEN",
  transfer: "ftps",
};
const base = { connection: conn, subdomain: "app", rootDomain: "example.com", docroot: "public_html/app", localDir: "dist" };

test("uapi step compiles to a curl to the cPanel UAPI with token header", () => {
  const cmds = toCommands(planDeploy(base), conn);
  const uapi = cmds.find((c) => c.label.startsWith("uapi"));
  assert.equal(uapi.bin, "curl");
  const url = uapi.args.at(-1);
  assert.match(url, /https:\/\/server\.example-host\.com:2083\/execute\/SubDomain\/addsubdomain/);
  assert.ok(uapi.args.includes("Authorization: cpanel acctuser:$CPANEL_API_TOKEN"));
});

test("ftp creation passes the password from env, never a literal", () => {
  const cmds = toCommands(planDeploy({ ...base, createFtp: true, ftpUser: "app_ftp" }), conn);
  const ftp = cmds.find((c) => c.label.includes("Ftp/add_ftp"));
  const url = ftp.args.at(-1);
  assert.match(url, /password=\$FTP_PASSWORD/);
  assert.ok(!/password=hunter2|secret/i.test(url));
});

test("ftps upload uses lftp mirror with $FTP_PASSWORD env ref", () => {
  const cmds = toCommands(planDeploy(base), conn);
  const up = cmds.find((c) => c.label.startsWith("upload"));
  assert.equal(up.bin, "lftp");
  assert.match(up.args.at(-1), /open -u acctuser,\$FTP_PASSWORD/);
  assert.match(up.args.at(-1), /mirror -R --delete dist public_html\/app/);
});

test("verify curls the https subdomain", () => {
  const cmds = toCommands(planDeploy(base), conn);
  const v = cmds.find((c) => c.label.startsWith("verify"));
  assert.deepEqual(v.args, ["-fsk", "https://app.example.com/", "-o", "/dev/null"]);
});

test("dry-run render contains no token/password material", () => {
  const rendered = renderCommands(toCommands(planDeploy({ ...base, createFtp: true, ftpUser: "app_ftp" }), conn));
  assert.ok(rendered.includes("$CPANEL_API_TOKEN")); // env ref only
  assert.ok(rendered.includes("$FTP_PASSWORD"));
  assert.ok(!/:\s*[A-Z0-9]{20,}/.test(rendered)); // no obvious literal token
});
