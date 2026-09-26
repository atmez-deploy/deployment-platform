#!/usr/bin/env node
// Auto-detect HOW to build a static site repo — so a client never has to tell us.
//
// PURE resolver (detectBuild) + a thin CLI. Given a description of the repo's top-level
// files (and package.json contents when present), it returns:
//   { command, packageManager, reason }   command === "" means "no build, serve as-is".
//
// Strategy (first match wins, most specific -> safest fallback):
//   1) Node project with a "build" script  -> <pm> install && <pm> run build
//      package manager chosen by lockfile: pnpm-lock.yaml -> pnpm, yarn.lock -> yarn, else npm.
//   2) Known static-site generators by signature file:
//        config.toml/hugo.toml + content/  -> hugo
//        _config.yml (+ Gemfile)           -> bundle exec jekyll build
//        gatsby-config.*                    -> npm run build (falls under Node usually)
//   3) Node project WITHOUT a build script -> no build (likely already static / nothing to do)
//   4) Plain HTML (index.html present, no tooling) -> no build
//   5) Nothing recognizable -> no build (serve as-is), reason explains why
//
// The engine still AUTO-DETECTS the OUTPUT folder separately (detect-output.mjs), so this
// module only decides the command. Safe by construction: when unsure it does NOT invent a
// build (which would fail); it serves files as-is and the deploy still runs.

import { readdirSync, existsSync, readFileSync } from "node:fs";

/**
 * @param {Object} repo
 * @param {string[]} repo.files         top-level entry names (files + dirs)
 * @param {object|null} [repo.packageJson]  parsed package.json, or null if absent
 * @returns {{command:string, packageManager:string|null, reason:string}}
 */
export function detectBuild({ files, packageJson = null }) {
  const has = (name) => files.includes(name);

  // 1) Node project with a build script.
  if (packageJson && packageJson.scripts && typeof packageJson.scripts.build === "string" && packageJson.scripts.build.trim() !== "") {
    let pm = "npm", install = "npm ci", run = "npm run build";
    if (has("pnpm-lock.yaml")) { pm = "pnpm"; install = "pnpm install --frozen-lockfile"; run = "pnpm run build"; }
    else if (has("yarn.lock")) { pm = "yarn"; install = "yarn install --frozen-lockfile"; run = "yarn build"; }
    // npm ci needs a lockfile; if none, fall back to npm install
    else if (!has("package-lock.json")) { install = "npm install"; }
    return { command: `${install} && ${run}`, packageManager: pm, reason: `package.json has a build script (${pm})` };
  }

  // 2) Known static-site generators (no package.json build, or non-Node).
  if (has("hugo.toml") || ((has("config.toml") || has("config.yaml")) && has("content"))) {
    return { command: "hugo --minify", packageManager: null, reason: "Hugo site detected (config + content/)" };
  }
  if (has("_config.yml") && has("Gemfile")) {
    return { command: "bundle install && bundle exec jekyll build", packageManager: "bundler", reason: "Jekyll site detected (_config.yml + Gemfile)" };
  }

  // 3) Node project but no build script -> nothing to build.
  if (packageJson) {
    return { command: "", packageManager: null, reason: "package.json present but no build script — serving files as-is" };
  }

  // 4) Plain HTML site.
  if (has("index.html")) {
    return { command: "", packageManager: null, reason: "plain HTML (index.html present, no build tooling)" };
  }

  // 5) Nothing recognizable — safest is no build.
  return { command: "", packageManager: null, reason: "no build tooling recognized — serving files as-is" };
}

/** Read a repo directory into the shape detectBuild expects. */
export function inspectRepo(root = ".") {
  const files = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.name !== ".git" && e.name !== "node_modules")
    .map((e) => e.name);
  let packageJson = null;
  if (files.includes("package.json")) {
    try { packageJson = JSON.parse(readFileSync(`${root}/package.json`, "utf8")); } catch { packageJson = null; }
  }
  return { files, packageJson };
}

// ---- CLI ----
// Usage: node tools/detect-build.mjs [rootDir]
//   prints the build command on stdout ("" for no build) and the reason on stderr.
function main() {
  const root = process.argv[2] || ".";
  const { command, reason } = detectBuild(inspectRepo(root));
  process.stderr.write(`build: ${command || "(none)"} — ${reason}\n`);
  process.stdout.write(command);
}

import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
