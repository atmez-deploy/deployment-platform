#!/usr/bin/env node
// Validates every examples/*.project.yaml against schemas/project.schema.json.
// Zero surprises: exits non-zero if any example fails, prints readable errors.
//
// Usage:
//   npm install        # once, installs ajv + ajv-formats + js-yaml
//   npm run validate   # or: node tools/validate.mjs

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { load as parseYaml } from "js-yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = join(root, "schemas", "project.schema.json");
const examplesDir = join(root, "examples");

const schema = JSON.parse(readFileSync(schemaPath, "utf8"));

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

const files = readdirSync(examplesDir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));

if (files.length === 0) {
  console.error("No example configs found in examples/");
  process.exit(1);
}

let failed = 0;
for (const file of files) {
  const data = parseYaml(readFileSync(join(examplesDir, file), "utf8"));
  const ok = validate(data);
  if (ok) {
    console.log(`PASS  ${file}`);
  } else {
    failed++;
    console.log(`FAIL  ${file}`);
    for (const err of validate.errors ?? []) {
      console.log(`        ${err.instancePath || "(root)"} ${err.message}`);
    }
  }
}

console.log(`\n${files.length - failed}/${files.length} examples valid.`);
process.exit(failed === 0 ? 0 : 1);
