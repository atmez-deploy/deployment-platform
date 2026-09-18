import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveProject, listProjectIds } from "./projects.mjs";

const registry = {
  schema_version: "1.0",
  projects: [
    {
      id: "acme-marketing",
      repo: "https://github.com/acme/marketing-site.git",
      branch: "main",
      build: { command: "npm ci && npm run build", output_dir: "dist" },
      target: {
        driver: "hostinger",
        host: "145.223.17.98",
        port: 65002,
        username: "u443001285",
        auth: "ssh_key",
        webroot: "domains/acme.com/public_html",
        transfer: "rsync",
        secret_ref: "DEPLOY_SSH_KEY",
      },
      exposure: { domain: "acme.com", ssl: "managed_by_provider" },
    },
    {
      id: "bakery-landing",
      repo: "https://github.com/example/bakery-landing.git",
      build: { output_dir: "public" }, // no command
      target: {
        driver: "hostinger",
        host: "ftp.bakery.com",
        port: 21,
        username: "u987654321",
        auth: "ftps",
        webroot: "public_html",
        transfer: "ftps",
        secret_ref: "BAKERY_FTP_PASSWORD",
      },
      exposure: { domain: "www.bakery.com" },
    },
  ],
};

test("listProjectIds returns every id", () => {
  assert.deepEqual(listProjectIds(registry), ["acme-marketing", "bakery-landing"]);
});

test("resolveProject returns clone info + a valid deploy config shape", () => {
  const r = resolveProject(registry, "acme-marketing");
  assert.equal(r.clone.repo, "https://github.com/acme/marketing-site.git");
  assert.equal(r.clone.branch, "main");
  assert.equal(r.clone.tokenRef, null);
  assert.equal(r.build.command, "npm ci && npm run build");
  assert.equal(r.build.outputDir, "dist");
  assert.equal(r.environment, "production");
  assert.equal(r.secretRef, "DEPLOY_SSH_KEY");
  // the generated config is the exact shape the static driver/CLI consume
  const env = r.deployConfig.environments.production;
  assert.equal(env.deployment.type, "static");
  assert.equal(env.target.driver, "hostinger");
  assert.equal(env.target.webroot, "domains/acme.com/public_html");
  assert.equal(env.target.secret_ref, "DEPLOY_SSH_KEY");
  assert.equal(env.build.command, "npm ci && npm run build");
  assert.equal(env.build.output_dir, "dist");
  assert.equal(env.services.site.exposure.domain, "acme.com");
});

test("resolveProject defaults branch to main and omits an empty build command", () => {
  const r = resolveProject(registry, "bakery-landing");
  assert.equal(r.clone.branch, "main");
  assert.equal(r.build.command, null);
  const env = r.deployConfig.environments.production;
  assert.equal("command" in env.build, false); // no-build site: no command key
  assert.equal(env.build.output_dir, "public");
});

test("unknown id throws with the known ids listed", () => {
  assert.throws(() => resolveProject(registry, "nope"), /unknown project id 'nope'/);
});

test("invalid id slug is rejected", () => {
  assert.throws(() => resolveProject(registry, "Bad Id"), /invalid project id/);
});

test("invalid repo URL is rejected", () => {
  const bad = { projects: [{ id: "x", repo: "not-a-url", target: { driver: "hostinger", webroot: "p", secret_ref: "K" } }] };
  assert.throws(() => resolveProject(bad, "x"), /invalid repo URL/);
});

test("missing target.secret_ref is rejected", () => {
  const bad = { projects: [{ id: "x", repo: "https://github.com/a/b.git", target: { driver: "hostinger", webroot: "p" } }] };
  assert.throws(() => resolveProject(bad, "x"), /secret_ref is required/);
});

test("bad repo_token_ref name is rejected", () => {
  const bad = {
    projects: [{ id: "x", repo: "https://github.com/a/b.git", repo_token_ref: "lower case", target: { driver: "hostinger", webroot: "p", secret_ref: "K" } }],
  };
  assert.throws(() => resolveProject(bad, "x"), /invalid repo_token_ref/);
});
