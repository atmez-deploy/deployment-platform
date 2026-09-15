#!/usr/bin/env node
// Sanity check that the schema REJECTS invalid configs (validation has teeth).
// Each case below must fail validation; if any is accepted, this script errors.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(readFileSync(join(root, "schemas", "project.schema.json"), "utf8"));
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

const base = {
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

const clone = (o) => JSON.parse(JSON.stringify(o));

const cases = [];

// 1. static without build must fail
{
  const c = clone(base);
  c.environments.production.deployment = { type: "static" };
  cases.push(["static without build", c]);
}
// 2. unknown top-level property must fail (additionalProperties:false)
{
  const c = clone(base);
  c.bogus = true;
  cases.push(["unknown top-level key", c]);
}
// 3. target missing required driver fields must fail (oneOf)
{
  const c = clone(base);
  c.environments.production.target = { driver: "hostinger" }; // missing host/webroot/auth
  cases.push(["incomplete hostinger target", c]);
}
// 4. bad project name (uppercase) must fail the slug pattern
{
  const c = clone(base);
  c.project.name = "BadName";
  cases.push(["invalid project name slug", c]);
}
// 5. domain exposure without domain must fail
{
  const c = clone(base);
  c.environments.production.services.web = { exposure: { type: "domain" } };
  cases.push(["domain exposure without domain", c]);
}

let leaked = 0;
for (const [name, cfg] of cases) {
  const ok = validate(cfg);
  if (ok) {
    leaked++;
    console.log(`LEAK  accepted invalid config: ${name}`);
  } else {
    console.log(`OK    rejected: ${name}`);
  }
}
console.log(`\n${cases.length - leaked}/${cases.length} invalid configs correctly rejected.`);
process.exit(leaked === 0 ? 0 : 1);
