#!/usr/bin/env node
// Portable unit-test runner. Discovers engine/**/*.test.mjs ourselves and runs them
// via `node --test <files...>`. This avoids shell/Node-version glob differences
// (bash doesn't expand ** by default; Node 20 vs 24 handle --test globs differently).

import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const engineDir = join(root, "engine");

function findTests(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findTests(full));
    else if (entry.name.endsWith(".test.mjs")) out.push(full);
  }
  return out;
}

const files = findTests(engineDir);
if (files.length === 0) {
  console.error("no test files found under engine/");
  process.exit(1);
}

const res = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(res.status ?? 1);
