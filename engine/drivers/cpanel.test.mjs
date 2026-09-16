// Unit tests for the cPanel driver plan generation. Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { planDeploy } from "./cpanel.mjs";

const connection = {
  host: "server.example-host.com",
  port: 2083,
  username: "acctuser",
  apiTokenRef: "CPANEL_API_TOKEN",
  transfer: "ftps",
};

const base = {
  connection,
  subdomain: "app",
  rootDomain: "example.com",
  docroot: "public_html/app",
  localDir: "dist",
};

test("plan provisions subdomain then uploads then verifies", () => {
  const types = planDeploy(base).steps.map((s) => s.type);
  assert.deepEqual(types, ["uapi", "upload", "verify"]);
});

test("subdomain step uses UAPI SubDomain/addsubdomain with the right params", () => {
  const step = planDeploy(base).steps[0];
  assert.equal(step.module, "SubDomain");
  assert.equal(step.func, "addsubdomain");
  assert.deepEqual(step.params, { domain: "app", rootdomain: "example.com", dir: "public_html/app" });
  assert.equal(step.ignoreIfExists, true);
});

test("createFtp adds an Ftp/add_ftp step with password from env (not embedded)", () => {
  const plan = planDeploy({ ...base, createFtp: true, ftpUser: "app_ftp" });
  const ftp = plan.steps.find((s) => s.module === "Ftp");
  assert.equal(ftp.func, "add_ftp");
  assert.equal(ftp.params.user, "app_ftp");
  assert.equal(ftp.passwordFromEnv, "FTP_PASSWORD");
  assert.ok(!("password" in ftp.params)); // never a literal
});

test("verify targets the https fqdn", () => {
  const v = planDeploy(base).steps.find((s) => s.type === "verify");
  assert.equal(v.url, "https://app.example.com/");
});

test("rejects injection-y labels and missing fields", () => {
  assert.throws(() => planDeploy({ ...base, subdomain: "a; rm -rf /" }), /invalid subdomain/);
  assert.throws(() => planDeploy({ ...base, docroot: "" }), /docroot is required/);
  assert.throws(() => planDeploy({ ...base, createFtp: true }), /ftpUser is required/);
});

test("deterministic", () => {
  assert.deepEqual(planDeploy(base), planDeploy(base));
});
