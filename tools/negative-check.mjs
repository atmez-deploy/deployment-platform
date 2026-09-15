#!/usr/bin/env node
// Sanity check that schemas REJECT invalid configs (validation has teeth).
// Every case below must FAIL validation; if any is accepted, this script errors.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const clone = (o) => JSON.parse(JSON.stringify(o));

function compile(rel) {
  const schema = JSON.parse(readFileSync(join(root, rel), "utf8"));
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(schema);
}

const validateProject = compile("schemas/project.schema.json");
const validateRegistry = compile("schemas/registry.schema.json");

// ---- project schema negative cases ----
const projectBase = {
  project: { name: "x" },
  repository: { organization: "o", repository: "r" },
  environments: {
    production: {
      deployment: { type: "docker" },
      target: { driver: "vps", ref: "vps-01" },
      services: { web: { exposure: { type: "internal" } } },
    },
  },
};

const cases = [];

{
  const c = clone(projectBase);
  c.environments.production.deployment = { type: "static" };
  cases.push([validateProject, "project: static without build", c]);
}
{
  const c = clone(projectBase);
  c.bogus = true;
  cases.push([validateProject, "project: unknown top-level key", c]);
}
{
  const c = clone(projectBase);
  c.environments.production.target = { driver: "hostinger" };
  cases.push([validateProject, "project: incomplete hostinger target", c]);
}
{
  const c = clone(projectBase);
  c.project.name = "BadName";
  cases.push([validateProject, "project: invalid name slug", c]);
}
{
  const c = clone(projectBase);
  c.environments.production.services.web = { exposure: { type: "domain" } };
  cases.push([validateProject, "project: domain exposure without domain", c]);
}

// ---- registry schema negative cases ----
const registryBase = {
  schema_version: "1.0",
  resources: [
    {
      id: "vps-01",
      kind: "vps",
      connection: { host: "h", username: "u", ssh_key_ref: "k" },
      port_pools: { backend: { start: 5000, end: 5099 } },
      projects: [],
    },
  ],
};

{
  const c = clone(registryBase);
  c.resources[0].connection = { host: "h", username: "u" }; // missing ssh_key_ref
  cases.push([validateRegistry, "registry: connection missing ssh_key_ref", c]);
}
{
  const c = clone(registryBase);
  c.resources[0].port_pools.backend.end = 70000; // out of port range
  cases.push([validateRegistry, "registry: port pool end out of range", c]);
}
{
  const c = clone(registryBase);
  // vps entry with no port_pools must fail (required)
  delete c.resources[0].port_pools;
  cases.push([validateRegistry, "registry: vps without port_pools", c]);
}
{
  const c = clone(registryBase);
  c.resources[0].secret = "supersecret"; // additionalProperties:false — no secrets field
  cases.push([validateRegistry, "registry: unknown/secret field on vps", c]);
}
{
  const c = clone(registryBase);
  c.resources.push({ id: "x", kind: "external", provider: "unknown-host" }); // bad provider enum
  cases.push([validateRegistry, "registry: external with invalid provider", c]);
}

let leaked = 0;
for (const [validate, name, cfg] of cases) {
  const ok = validate(cfg);
  if (ok) {
    leaked++;
    console.log(`LEAK  accepted invalid: ${name}`);
  } else {
    console.log(`OK    rejected: ${name}`);
  }
}
console.log(`\n${cases.length - leaked}/${cases.length} invalid configs correctly rejected.`);
process.exit(leaked === 0 ? 0 : 1);
