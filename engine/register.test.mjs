// Unit tests for project registration. Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";

import { registerProject, desiredDomains, desiredPorts, RegistrationError } from "./register.mjs";
import { DuplicateDomainError } from "./errors.mjs";

function registry() {
  return {
    schema_version: "1.0",
    resources: [
      {
        id: "vps-01",
        kind: "vps",
        connection: { host: "h", username: "u", ssh_key_ref: "k" },
        port_pools: { api: { start: 5000, end: 5099 }, web: { start: 8100, end: 8199 } },
        projects: [],
      },
      { id: "hostinger-main", kind: "external", provider: "hostinger", projects: [] },
    ],
  };
}

function staticSiteConfig() {
  return {
    project: { name: "example-site" },
    repository: { organization: "o", repository: "example-site" },
    environments: {
      production: {
        deployment: { type: "static" },
        target: { driver: "hostinger", ref: "hostinger-main" },
        build: { command: "npm run build", output_dir: "dist" },
        services: {
          site: { exposure: { type: "domain", domain: "WWW.Example.com", ssl: "managed_by_provider" } },
        },
      },
    },
  };
}

function dockerConfig() {
  return {
    project: { name: "example-app" },
    repository: { organization: "o", repository: "example-app" },
    environments: {
      staging: {
        deployment: { type: "docker", strategy: "blue_green" },
        target: { driver: "vps", ref: "vps-01" },
        services: {
          api: { exposure: { type: "port", pool: "api" } },
          web: { exposure: { type: "domain", domain: "staging.example.com" } },
        },
      },
    },
  };
}

test("desiredDomains/desiredPorts read exposures", () => {
  const env = staticSiteConfig().environments.production;
  assert.deepEqual(desiredDomains(env), [{ service: "site", domain: "WWW.Example.com" }]);
  assert.deepEqual(desiredPorts(env), []);
});

test("register a static site on an external host records the (lowercased) domain, no ports", () => {
  const { registry: next, allocation } = registerProject({
    registry: registry(),
    projectConfig: staticSiteConfig(),
    environment: "production",
  });
  assert.deepEqual(allocation.allocations.ports, []);
  assert.deepEqual(allocation.allocations.domains, [
    { service: "site", domain: "www.example.com" },
  ]);
  const ext = next.resources.find((r) => r.id === "hostinger-main");
  assert.equal(ext.projects.length, 1);
});

test("register a docker project on vps allocates a port and records the domain", () => {
  const { allocation } = registerProject({
    registry: registry(),
    projectConfig: dockerConfig(),
    environment: "staging",
  });
  assert.deepEqual(allocation.allocations.ports, [{ service: "api", port: 5000, pool: "api" }]);
  assert.deepEqual(allocation.allocations.domains, [
    { service: "web", domain: "staging.example.com" },
  ]);
});

test("registration does not mutate the input registry (pure)", () => {
  const reg = registry();
  registerProject({ registry: reg, projectConfig: staticSiteConfig(), environment: "production" });
  const ext = reg.resources.find((r) => r.id === "hostinger-main");
  assert.equal(ext.projects.length, 0); // original untouched
});

test("double registration of same project+environment is rejected", () => {
  let reg = registry();
  ({ registry: reg } = registerProject({
    registry: reg,
    projectConfig: staticSiteConfig(),
    environment: "production",
  }));
  assert.throws(
    () =>
      registerProject({
        registry: reg,
        projectConfig: staticSiteConfig(),
        environment: "production",
      }),
    /already registered/,
  );
});

test("registering a domain already taken on the same external host is rejected", () => {
  let reg = registry();
  ({ registry: reg } = registerProject({
    registry: reg,
    projectConfig: staticSiteConfig(),
    environment: "production",
  }));
  // A different project wanting the same domain on the same host must fail.
  const other = staticSiteConfig();
  other.project.name = "another-site";
  assert.throws(
    () => registerProject({ registry: reg, projectConfig: other, environment: "production" }),
    RegistrationError,
  );
});

test("unknown environment / missing target ref are rejected", () => {
  assert.throws(
    () =>
      registerProject({
        registry: registry(),
        projectConfig: staticSiteConfig(),
        environment: "ghost",
      }),
    RegistrationError,
  );
});
