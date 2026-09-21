import { test } from "node:test";
import assert from "node:assert/strict";
import { runPreflight, requiredSecretsFor } from "./preflight-check.mjs";

const staticSsh = {
  project: { name: "site" },
  environments: {
    production: {
      deployment: { type: "static" },
      target: { driver: "hostinger", auth: "ssh_key", webroot: "public_html" },
      build: { output_dir: "dist" },
      services: { site: { exposure: { type: "domain", domain: "x.com" } } },
    },
  },
};

const dockerVps = {
  project: { name: "api" },
  environments: {
    production: {
      deployment: { type: "docker" },
      target: { driver: "vps", ref: "vps-02" },
      services: { backend: { exposure: { type: "domain", domain: "api.x.com" } } },
    },
  },
};

test("requiredSecretsFor maps each driver", () => {
  assert.deepEqual(requiredSecretsFor({ driver: "hostinger", auth: "ssh_key" }).required, ["DEPLOY_SSH_KEY"]);
  assert.deepEqual(requiredSecretsFor({ driver: "hostinger", auth: "ftps" }).required, ["FTP_PASSWORD"]);
  assert.deepEqual(requiredSecretsFor({ driver: "vps" }).required, ["DEPLOY_SSH_KEY"]);
  assert.deepEqual(requiredSecretsFor({ driver: "cpanel" }).required, ["CPANEL_API_TOKEN"]);
});

test("unknown environment fails fast", () => {
  const r = runPreflight({ config: staticSsh, environment: "nope" });
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.includes('environment "nope" exists')));
});

test("static passes when dir + secret present", () => {
  const r = runPreflight({
    config: staticSsh,
    environment: "production",
    presentSecrets: ["DEPLOY_SSH_KEY"],
    inputs: { dir: "dist" },
  });
  assert.equal(r.ok, true, JSON.stringify(r.failures));
});

test("static fails without dir and without secret", () => {
  const r = runPreflight({ config: staticSsh, environment: "production", presentSecrets: [], inputs: {} });
  assert.equal(r.ok, false);
  assert.ok(r.failures.includes("build dir provided"));
  assert.ok(r.failures.includes("secret DEPLOY_SSH_KEY is set"));
});

test("docker requires a well-formed image and the ssh key", () => {
  const bad = runPreflight({ config: dockerVps, environment: "production", presentSecrets: ["DEPLOY_SSH_KEY"], inputs: { image: "bad ref" } });
  assert.equal(bad.ok, false);
  assert.ok(bad.failures.includes("image ref is immutable/well-formed"));

  const good = runPreflight({
    config: dockerVps,
    environment: "production",
    presentSecrets: ["DEPLOY_SSH_KEY"],
    inputs: { image: "ghcr.io/o/r:abc123" },
  });
  assert.equal(good.ok, true, JSON.stringify(good.failures));
});

test("invalid branch ref is flagged", () => {
  const r = runPreflight({
    config: staticSsh,
    environment: "production",
    presentSecrets: ["DEPLOY_SSH_KEY"],
    inputs: { dir: "dist", branch: "bad branch;rm" },
  });
  assert.equal(r.ok, false);
  assert.ok(r.failures.includes("branch is a valid ref"));
});

test("ftps webroot can come from a secret instead of config", () => {
  const cfg = JSON.parse(JSON.stringify(staticSsh));
  cfg.environments.production.target = { driver: "hostinger", auth: "ftps" }; // no webroot in config
  const r = runPreflight({
    config: cfg,
    environment: "production",
    presentSecrets: ["FTP_PASSWORD", "DEPLOY_WEBROOT"],
    inputs: { dir: "dist" },
  });
  assert.equal(r.ok, true, JSON.stringify(r.failures));
});
