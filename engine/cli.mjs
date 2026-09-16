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
//   FTP_PASSWORD     password (static ftps only)
//   FTP_HOST/FTP_USERNAME/FTP_WEBROOT  optional overrides for ftps connection

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
  const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--execute") { opts.execute = true; continue; }
    if (!a.startsWith("--")) continue;
    const key = camel(a.slice(2));
    const val = rest[++i];
    if (key === "image") {
      // repeatable: accumulate into an array
      opts.image = [].concat(opts.image ?? [], val);
    } else {
      opts[key] = val;
    }
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
  // Connection fields may come from the config OR from repo secrets injected as env.
  // For FTP-only sites, teams typically keep host/user in secrets, not in the repo config.
  const env = process.env;
  const conn = {
    host: env.FTP_HOST || t.host,
    port: t.port ?? (t.auth === "ftps" ? 21 : 22),
    username: env.FTP_USERNAME || t.username,
    webroot: env.FTP_WEBROOT || t.webroot,
    auth: t.auth,
    transfer: t.transfer ?? (t.auth === "ftps" ? "ftps" : "rsync"),
  };
  if (!conn.host) fail("host not set (config target.host or FTP_HOST secret)");
  if (!conn.username) fail("username not set (config target.username or FTP_USERNAME secret)");
  if (!conn.webroot) fail("webroot not set (config target.webroot or FTP_WEBROOT secret)");
  return conn;
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

    // ---- docker services (vps, compose blue/green) ----
    // Deploys ALL services in the environment together (compose model). Images are given
    // as --image name=ref pairs (repeatable), or a single --image ref applied to a lone
    // service. Per-color host ports: the registry-allocated port is BLUE; GREEN = BLUE +
    // --color-offset (default 1) unless the registry records an explicit green port.
    case "deploy-service":
    case "rollback-service": {
      if (!opts.registry) fail("--registry <path> is required");
      const t = envConfig.target;
      if (t?.driver !== "vps") fail(`expected 'vps' driver for ${opts.command} (got '${t?.driver}')`);
      const cfg = loadYaml(opts.config);
      const project = cfg?.project?.name;
      const registry = loadYaml(opts.registry);
      const vps = resolveTarget(registry, t.ref);
      const colorOffset = Number(opts.colorOffset ?? 1);

      // parse --image (repeatable): "name=ref" or a bare "ref" for a single service
      const images = {};
      for (const spec of [].concat(opts.image ?? [])) {
        if (spec.includes("=")) {
          const [n, ref] = spec.split("=");
          images[n] = ref;
        } else {
          images.__single = spec;
        }
      }

      const rec = (vps.projects ?? []).find((p) => p.project === project && p.environment === opts.env);
      if (!rec) fail(`${project}/${opts.env} not registered on ${t.ref}`);
      const portOf = (svcName) => (rec.allocations?.ports ?? []).find((p) => p.service === svcName)?.port;
      const domainOf = (svcName) => (rec.allocations?.domains ?? []).find((d) => d.service === svcName)?.domain;

      const svcNames = Object.keys(envConfig.services ?? {});
      if (svcNames.length === 0) fail("no services in this environment");

      const services = svcNames.map((name) => {
        const svc = envConfig.services[name];
        const blue = portOf(name);
        if (!Number.isInteger(blue)) fail(`no port allocated for service '${name}' in the registry`);
        const image = images[name] ?? (svcNames.length === 1 ? images.__single : undefined);
        if (opts.command === "deploy-service" && !image) fail(`no --image provided for service '${name}'`);
        return {
          name,
          role: svc.role,
          image,
          containerPort: svc.container_port ?? (name === "backend" ? 3000 : 80),
          hostPortBlue: blue,
          hostPortGreen: blue + colorOffset,
          domain: domainOf(name) ?? svc.exposure?.domain,
          ssl: svc.exposure?.ssl === true,
          envFromSecret: svc.env_secret, // env var name holding the .env contents
          volumes: svc.volumes,
          healthPath: svc.health?.path ?? "/",
        };
      });

      const connection = {
        host: vps.connection.host,
        port: vps.connection.port ?? 22,
        username: vps.connection.username,
      };
      const basePath = vps.base_path ?? "/opt";
      const db = envConfig.database
        ? { enabled: true, hostPort: envConfig.database.host_port, volumeName: `${project}_postgres_data` }
        : {};

      const plan =
        opts.command === "deploy-service"
          ? dockerVps.planDeploy({
              project,
              environment: opts.env,
              services,
              db,
              basePath,
              migrate: envConfig.database?.migrate
                ? { service: "backend", command: envConfig.database.migrate_command ?? "true" }
                : null,
            })
          : dockerVps.planRollback({ project, environment: opts.env, services, basePath });
      run(opts.command, plan, connection);
      break;
    }

    default:
      fail(`unknown command '${opts.command}'`);
  }
}

main();
