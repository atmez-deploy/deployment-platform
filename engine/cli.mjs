#!/usr/bin/env node
// Thin CLI entrypoint. The ONE place callers (GitHub Actions now, a backend later)
// invoke the engine. It maps process args + env into a normalized InputContext,
// resolves the target, and runs the static publisher plan.
//
// It is deliberately small: all real logic lives in the pure engine modules.
// Secrets arrive via env (the SecretProvider boundary) — never on the command line.
//
// Usage:
//   node engine/cli.mjs deploy   --config <path> --env <name> --sha <sha> --dir <builtDir> [--execute]
//   node engine/cli.mjs rollback --config <path> --env <name> --to <sha>             [--execute]
//
// Env:
//   DEPLOY_SSH_KEY   PEM contents of the SSH private key (for auth=ssh_key)
//   FTPS_PASSWORD    password (for auth=ftps)

import { readFileSync, writeFileSync, mkdtempSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load as parseYaml } from "js-yaml";

import { planDeploy, planRollback } from "./drivers/static-hostinger.mjs";
import { runPlan, renderCommands, toCommands } from "./executor.mjs";

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { command, execute: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--execute") opts.execute = true;
    else if (a.startsWith("--")) opts[a.slice(2)] = rest[++i];
  }
  return opts;
}

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

/** Build the connection object for the hostinger target from the project config. */
function hostingerConnection(envConfig) {
  const t = envConfig.target;
  if (t?.driver !== "hostinger") {
    fail(`this MVP CLI only supports the 'hostinger' driver (got '${t?.driver}')`);
  }
  return {
    host: t.host,
    port: t.port ?? 22,
    username: t.username,
    webroot: t.webroot,
    auth: t.auth,
    transfer: t.transfer ?? (t.auth === "ftps" ? "ftps" : "rsync"),
  };
}

/** Write the SSH key from env to a locked-down temp file; return its path + a cleanup fn. */
function materializeKey() {
  const key = process.env.DEPLOY_SSH_KEY;
  if (!key) return { keyPath: undefined, cleanup: () => {} };
  const dir = mkdtempSync(join(tmpdir(), "dpk-"));
  const keyPath = join(dir, "id");
  writeFileSync(keyPath, key.endsWith("\n") ? key : key + "\n", { mode: 0o600 });
  chmodSync(keyPath, 0o600);
  return { keyPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function loadEnvConfig(configPath, envName) {
  const cfg = parseYaml(readFileSync(configPath, "utf8"));
  const envConfig = cfg?.environments?.[envName];
  if (!envConfig) fail(`environment '${envName}' not found in ${configPath}`);
  return { cfg, envConfig };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.command) fail("usage: cli.mjs <deploy|rollback> --config <path> --env <name> ...");
  if (!opts.config) fail("--config is required");
  if (!opts.env) fail("--env is required");

  const { envConfig } = loadEnvConfig(opts.config, opts.env);
  const connection = hostingerConnection(envConfig);

  let plan;
  if (opts.command === "deploy") {
    if (!opts.sha) fail("--sha is required for deploy");
    if (!opts.dir) fail("--dir (built site directory) is required for deploy");
    plan = planDeploy({ connection, sha: opts.sha, localDir: opts.dir });
  } else if (opts.command === "rollback") {
    if (!opts.to) fail("--to <sha> is required for rollback");
    plan = planRollback({ connection, toSha: opts.to });
  } else {
    fail(`unknown command '${opts.command}'`);
  }

  const { keyPath, cleanup } = materializeKey();
  try {
    if (!opts.execute) {
      console.log(`# DRY RUN (${plan.mode}) — pass --execute to run for real\n`);
      console.log(renderCommands(toCommands(plan, connection, { keyPath })));
      return;
    }
    console.log(`# EXECUTING ${opts.command} (${plan.mode})`);
    const res = runPlan(plan, connection, { keyPath, execute: true });
    if (!res.ok) fail(`step failed: ${res.failedAt}`);
    console.log("# done");
  } finally {
    cleanup();
  }
}

main();
