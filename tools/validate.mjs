#!/usr/bin/env node
// Validates platform config instances against their JSON Schemas.
//   - examples/*.project.yaml   -> schemas/project.schema.json
//   - config/registry*.yaml     -> schemas/registry.schema.json
// Exits non-zero if any instance fails; prints readable errors.
//
// Usage:
//   npm install        # once, installs ajv + ajv-formats + js-yaml
//   npm run validate   # or: node tools/validate.mjs

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { load as parseYaml } from "js-yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function compile(schemaRelPath) {
  const schema = JSON.parse(readFileSync(join(root, schemaRelPath), "utf8"));
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(schema);
}

function yamlFilesIn(relDir, filter = () => true) {
  const dir = join(root, relDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => (f.endsWith(".yaml") || f.endsWith(".yml")) && filter(f))
    .map((f) => ({ label: `${relDir}/${f}`, path: join(dir, f) }));
}

const groups = [
  {
    name: "project configs",
    validate: compile("schemas/project.schema.json"),
    // Only *.project.yaml are project configs; other yaml in examples/ (e.g. the
    // caller-workflow template) are not validated against the project schema.
    files: yamlFilesIn("examples", (f) => f.endsWith(".project.yaml")),
  },
  {
    name: "resource registry",
    validate: compile("schemas/registry.schema.json"),
    files: yamlFilesIn("config", (f) => f.startsWith("registry")),
  },
];

let total = 0;
let failed = 0;
for (const group of groups) {
  if (group.files.length === 0) continue;
  console.log(`# ${group.name}`);
  for (const { label, path } of group.files) {
    total++;
    const data = parseYaml(readFileSync(path, "utf8"));
    const ok = group.validate(data);
    if (ok) {
      console.log(`PASS  ${label}`);
    } else {
      failed++;
      console.log(`FAIL  ${label}`);
      for (const err of group.validate.errors ?? []) {
        console.log(`        ${err.instancePath || "(root)"} ${err.message}`);
      }
    }
  }
}

if (total === 0) {
  console.error("No config instances found to validate.");
  process.exit(1);
}

console.log(`\n${total - failed}/${total} instances valid.`);
process.exit(failed === 0 ? 0 : 1);
