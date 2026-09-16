#!/usr/bin/env node
// Auto-detect a static build's output folder — so projects don't have to declare it.
//
// Strategy (detect-with-override):
//   - If an explicit dir is given (config build.output_dir), use it. Explicit always wins.
//   - Otherwise compare a BEFORE snapshot (top-level dirs + mtimes, taken before the build)
//     with the AFTER state: the folders that were newly created or freshly modified by the
//     build are the candidates. Prefer well-known output names; if exactly one candidate,
//     use it; if ambiguous (none or several with no clear winner), FAIL with guidance
//     rather than guess wrong.
//
// The pure resolver (resolveOutputDir) is separated from IO for unit testing.

import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";

// Preference order for known static output directory names.
export const KNOWN_OUTPUTS = ["dist", "out", "build", "public", "_site", ".output/public", "www", "site", "output"];

/**
 * Pure resolver.
 * @param {Object} args
 * @param {string} [args.explicit]   config-provided output_dir (wins if set)
 * @param {Array<{name:string,mtimeMs:number}>} args.before  snapshot before build
 * @param {Array<{name:string,mtimeMs:number}>} args.after   state after build
 * @returns {{dir:string, reason:string}}
 * @throws {Error} when it cannot confidently determine a single output dir
 */
export function resolveOutputDir({ explicit, before, after }) {
  if (explicit) return { dir: explicit, reason: "explicit (config build.output_dir)" };

  const beforeMap = new Map(before.map((d) => [d.name, d.mtimeMs]));
  // "changed" = created after the build, or mtime advanced during the build
  const changed = after
    .filter((d) => !beforeMap.has(d.name) || d.mtimeMs > (beforeMap.get(d.name) ?? 0))
    .map((d) => d.name);

  if (changed.length === 0) {
    throw new Error(
      "could not detect a build output folder (nothing changed). Set build.output_dir in the config.",
    );
  }

  // Prefer known output names, in preference order.
  const known = KNOWN_OUTPUTS.filter((k) => changed.includes(k));
  if (known.length === 1) return { dir: known[0], reason: "detected (only known output changed)" };
  if (known.length > 1) {
    // Multiple known names changed — pick the highest-preference one, but say so.
    return { dir: known[0], reason: `detected (preferred '${known[0]}' among ${known.join(", ")})` };
  }

  // No known names, but exactly one dir changed -> use it.
  if (changed.length === 1) return { dir: changed[0], reason: "detected (only one dir changed)" };

  // Ambiguous: several unknown dirs changed.
  throw new Error(
    `ambiguous build output — multiple dirs changed: ${changed.join(", ")}. Set build.output_dir in the config.`,
  );
}

/** Snapshot top-level directories with mtimes (used before/after the build). */
export function snapshotDirs(root = ".") {
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== ".git" && e.name !== "node_modules")
    .map((e) => ({ name: e.name, mtimeMs: statSync(`${root}/${e.name}`).mtimeMs }));
}

// ---- CLI ----
// Usage:
//   node tools/detect-output.mjs snapshot > before.json          (before build)
//   node tools/detect-output.mjs resolve --before before.json [--explicit dist]
function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "snapshot") {
    process.stdout.write(JSON.stringify(snapshotDirs(".")));
    return;
  }
  if (cmd === "resolve") {
    const opts = {};
    for (let i = 0; i < rest.length; i++) {
      if (rest[i].startsWith("--")) opts[rest[i].slice(2)] = rest[++i];
    }
    const before = opts.before && existsSync(opts.before) ? JSON.parse(readFileSync(opts.before, "utf8")) : [];
    const after = snapshotDirs(".");
    try {
      const { dir, reason } = resolveOutputDir({ explicit: opts.explicit || undefined, before, after });
      process.stderr.write(`output dir: ${dir} — ${reason}\n`);
      process.stdout.write(dir);
    } catch (e) {
      process.stderr.write(`error: ${e.message}\n`);
      process.exit(1);
    }
    return;
  }
  process.stderr.write("usage: detect-output.mjs <snapshot|resolve --before <file> [--explicit <dir>]>\n");
  process.exit(1);
}

// Only run CLI when invoked directly (not when imported by tests).
import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
