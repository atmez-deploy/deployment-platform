#!/usr/bin/env node
// Thin CLI entrypoint. The ONE place callers (GitHub Actions now, a backend later)
// invoke the engine. It maps process args + env into inputs, resolves the target,
// and runs a driver plan. All real logic lives in the pure engine modules.
// Secrets arrive via env (the SecretProvider boundary) — never on the command line.
//
// Static (Hostinger):
//   node engine/cli.mjs deploy   --config <p> --env <e> --sha <sha> --dir <builtDir> [--execute]
//   node engine/cli.mjs rollback --config <p> --env <e> --to <sha>                   [--execute]
//
// Docker service (VPS):
//   node engine/cli.mjs deploy-service   --config <p> --env <e> --service <s> --registry <r> --image <ref> [--execute]
//   node engine/cli.mjs rollback-service --config <p> --env <e> --service <s> --registry <r>                [--execute]
//
// Env:
//   DEPLOY_SSH_KEY   PEM contents of the SSH private key
//   FTPS_PASSWORD    password (static ftps only)

import { readFileSync, writeFileSync, mkdtempSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load as parseYaml } from "js-yaml";

import * as staticHostinger from "./drivers/static-hostinger.mjs";
import * as dockerVps from "./drivers/docker-vps.mjs";
import { runPlan, renderCommands, toCommands } from "./executor.mjs";
import { resolveTarget } from "./registry.mjs";

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

function loadYaml(path) {
  return parseYaml(readFileSync(path, "utf8"));
}

function loadEnvConfig(configPath, envName) {
  const cfg = loadYaml(configPath);
  const envConfig = cfg?.environments?.[envName];
  if (!envConfig) fail(`environment '${envName}' not found in ${configPath}`);
  return { cfg, envConfig };
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

function hostingerConnection(envConfig) {
  const t = envConfig.target;
  if (t?.driver !== "hostinger") fail(`expected 'hostinger' driver (got '${t?.driver}')`);
  return {
    host: t.host,
    port: t.port ?? 22,
    username: t.username,
    webroot: t.webroot,
    auth: t.auth,
    transfer: t.transfer ?? (t.auth === "ftps" ? "ftps" : "rsync"),
  };
}

/** Find the allocated host port + domain for a service on the vps from the registry. */
function serviceAllocation(registry, ref, project, environment, service) {
  const vps = resolveTarget(registry, ref);
  const rec = (vps.projects ?? []).find(
    (p) => p.project === project && p.environment === environment,
  );
  if (!rec) fail(`${project}/${environment} is not registered on ${ref}; run onboarding/registration first`);
  const portEntry = (rec.allocations?.ports ?? []).find((p) => p.service === service);
  const domainEntry = (rec.allocations?.domains ?? []).find((d) => d.service === service);
  return {
    vps,
    port: portEntry?.port,
    domain: domainEntry?.domain,
  };
}

function run(command, plan, connection) {
  const { keyPath, cleanup } = materializeKey();
  try {
    if (!globalThis.__execute) {
      console.log(`# DRY RUN (${plan.mode}) — pass --execute to run for real\n`);
      console.log(renderCommands(toCommands(plan, connection, { keyPath })));
      return;
    }
    console.log(`# EXECUTING ${command} (${plan.mode})`);
    const res = runPlan(plan, connection, { keyPath, execute: true });
    if (!res.ok) fail(`step failed: ${res.failedAt}`);
    console.log("# done");
  } finally {
    cleanup();
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  globalThis.__execute = opts.execute;
  if (!opts.command) fail("usage: cli.mjs <deploy|rollback|deploy-service|rollback-service> ...");
  if (!opts.config) fail("--config is required");
  if (!opts.env) fail("--env is required");

  const { envConfig } = loadEnvConfig(opts.config, opts.env);

  switch (opts.command) {
    // ---- static (hostinger) ----
    case "deploy": {
      if (!opts.sha) fail("--sha is required");
      if (!opts.dir) fail("--dir is required");
      const connection = hostingerConnection(envConfig);
      run(opts.command, staticHostinger.planDeploy({ connection, sha: opts.sha, localDir: opts.dir }), connection);
      break;
    }
    case "rollback": {
      if (!opts.to) fail("--to <sha> is required");
      const connection = hostingerConnection(envConfig);
      run(opts.command, staticHostinger.planRollback({ connection, toSha: opts.to }), connection);
      break;
    }

    // ---- docker service (vps) ----
    case "deploy-service":
    case "rollback-service": {
      if (!opts.service) fail("--service is required");
      if (!opts.registry) fail("--registry <path> is required");
      const t = envConfig.target;
      if (t?.driver !== "vps") fail(`expected 'vps' driver for ${opts.command} (got '${t?.driver}')`);
      const project = loadYaml(opts.config)?.project?.name;
      const registry = loadYaml(opts.registry);
      const { vps, port, domain } = serviceAllocation(registry, t.ref, project, opts.env, opts.service);
      if (!Number.isInteger(port)) fail(`no port allocated for service '${opts.service}'`);
      if (!domain) fail(`no domain allocated for service '${opts.service}'`);

      const connection = {
        host: vps.connection.host,
        port: vps.connection.port ?? 22,
        username: vps.connection.username,
      };
      const svc = envConfig.services?.[opts.service] ?? {};
      const ssl = svc.exposure?.ssl ?? false;

      if (opts.command === "deploy-service") {
        if (!opts.image) fail("--image <ref> is required for deploy-service");
        const plan = dockerVps.planDeploy({
          project,
          environment: opts.env,
          service: opts.service,
          image: opts.image,
          port,
          domain,
          ssl,
          health: svc.health ?? {},
          migrate: envConfig.database?.migrate ? { command: envConfig.database.migrate_command ?? "true" } : null,
          basePath: vps.base_path ?? "/opt/deployments",
        });
        run(opts.command, plan, connection);
      } else {
        const plan = dockerVps.planRollback({
          project,
          environment: opts.env,
          service: opts.service,
          port,
          domain,
          ssl,
          basePath: vps.base_path ?? "/opt/deployments",
        });
        run(opts.command, plan, connection);
      }
      break;
    }

    default:
      fail(`unknown command '${opts.command}'`);
  }
}

main();
