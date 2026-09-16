// Unit tests for the platform capability registry + preflight. Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { preflight, listPlatforms, PlatformError, PLATFORMS } from "./platforms.mjs";

test("listPlatforms returns the selectable platforms with a full-deploy flag", () => {
  const ids = listPlatforms().map((p) => p.id);
  assert.ok(ids.includes("vps"));
  assert.ok(ids.includes("hostinger-ssh"));
  assert.ok(ids.includes("hostinger-ftp"));
  assert.equal(listPlatforms().find((p) => p.id === "vps").supportsFullDeploy, true);
  assert.equal(listPlatforms().find((p) => p.id === "hostinger-ftp").supportsFullDeploy, false);
});

test("preflight flags missing required inputs per platform", () => {
  const r = preflight("vps", { config: 1, registry: 1, environment: 1, image: 1 }); // missing DEPLOY_SSH_KEY
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ["DEPLOY_SSH_KEY"]);
  assert.equal(r.driver, "vps");
  assert.equal(r.command, "deploy-service");
});

test("preflight passes when all required inputs present, returns checklist", () => {
  const r = preflight("hostinger-ftp", { config: 1, environment: 1, FTP_PASSWORD: 1 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.missing, []);
  assert.ok(r.checklist.length > 0);
});

test("optional inputs don't block preflight (FTP host/user optional)", () => {
  const r = preflight("hostinger-ftp", { config: 1, environment: 1, FTP_PASSWORD: 1 });
  assert.equal(r.ok, true); // FTP_HOST / FTP_USERNAME are optional
});

test("unknown platform throws PlatformError", () => {
  assert.throws(() => preflight("azure", {}), PlatformError);
});

test("every platform maps to a real driver + command", () => {
  for (const [, p] of Object.entries(PLATFORMS)) {
    assert.ok(["vps", "hostinger"].includes(p.kind));
    assert.ok(["deploy", "deploy-service"].includes(p.command));
  }
});
