#!/usr/bin/env node
// Onboard a site repo automatically. Given a target repo, this:
//   1) writes the caller workflow (.github/workflows/deploy.yml) into the repo
//   2) writes the site's deploy.project.yaml config into the repo
//   3) sets the repo's secrets (FTP_PASSWORD / FTP_HOST / ... or DEPLOY_SSH_KEY)
//   4) optionally triggers the first deploy
//
// It uses the GitHub REST API. Auth comes from GH_TOKEN in the env (a GitHub App
// installation token or a PAT with contents+secrets+actions write on the target repo).
// NOTHING is hardcoded; secret VALUES are read from env and never logged.
//
// Usage:
//   GH_TOKEN=... node tools/onboard.mjs \
//     --repo owner/name --domain www.example.com --auth ssh_key \
//     [--webroot domains/www.example.com/public_html] \
//     [--build "npm ci && npm run build"] [--output-dir dist] [--spa] \
//     [--platform-ref main] [--via-pr] [--no-deploy]
//
// Models:
//   default  -> pushes the two files straight to the repo's default branch, then triggers
//               the first deploy. Their repo's CI/CD runs on every push afterwards.
//   --via-pr -> opens a PR with the two files instead (needs only PR write, not push-to-main).
//               The client merges; the first deploy runs automatically on that merge.
//
// Flags:
//   --build ""   -> no build (publish files as-is); --spa -> write an .htaccess for router apps.
//
// Secret values (read from env, only those present are set):
//   FTP_PASSWORD, FTP_HOST, FTP_USERNAME, FTP_WEBROOT, DEPLOY_SSH_KEY

import { createRequire } from "node:module";
// libsodium-wrappers' ESM entry has a broken internal path in some versions; the
// CommonJS build is reliable, so load it via createRequire.
const require = createRequire(import.meta.url);
const sodium = require("libsodium-wrappers");

const API = "https://api.github.com";

function parseArgs(argv) {
  // SSH is the primary, proven path (rsync over ssh_key). FTP is only a fallback for the
  // cheapest Hostinger tiers (Single / WP-Single) that don't offer SSH — pass --auth ftps.
  const o = { deploy: true, platformRef: "main", auth: "ssh_key", kind: "static" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-deploy") o.deploy = false;
    else if (a === "--repo") o.repo = argv[++i];
    else if (a === "--domain") o.domain = argv[++i];
    else if (a === "--auth") o.auth = argv[++i];
    else if (a === "--kind") o.kind = argv[++i]; // static | service
    else if (a === "--vps-ref") o.vpsRef = argv[++i];
    else if (a === "--service") o.service = argv[++i];
    else if (a === "--platform-ref") o.platformRef = argv[++i];
    else if (a === "--environment") o.environment = argv[++i];
    else if (a === "--webroot") o.webroot = argv[++i];
    else if (a === "--build") o.build = argv[++i];         // build command; "" for no build
    else if (a === "--output-dir") o.outputDir = argv[++i];
    else if (a === "--spa") o.spa = true;                  // publish an .htaccess for router apps
    else if (a === "--via-pr") o.viaPr = true;             // open a PR instead of pushing to main
  }
  o.environment = o.environment || (o.kind === "service" ? "staging" : "production");
  o.service = o.service || "backend";
  return o;
}

function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

const token = process.env.GH_TOKEN;

async function gh(path, { method = "GET", body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "atmez-onboard",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    throw new Error(`GitHub ${method} ${path} -> ${res.status}: ${text}`);
  }
  return res.status === 404 ? null : res.json();
}

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

async function putFile(owner, repo, path, content, message) {
  // need the existing sha if the file already exists
  const existing = await gh(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`);
  await gh(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, {
    method: "PUT",
    body: {
      message,
      content: b64(content),
      sha: existing?.sha,
    },
  });
  console.log(`  wrote ${path}`);
}

/**
 * Open a PR that adds the given files, instead of pushing to the default branch.
 * Needs only contents-write + pull-request-write on the repo. Steps:
 *   1) read the default branch + its head sha
 *   2) create a setup branch from that sha
 *   3) PUT each file onto the branch
 *   4) open a PR from the branch into the default branch
 */
async function openSetupPr(owner, repo, files, title) {
  const repoInfo = await gh(`/repos/${owner}/${repo}`);
  if (!repoInfo) throw new Error(`repo ${owner}/${repo} not found or no access`);
  const base = repoInfo.default_branch;
  const ref = await gh(`/repos/${owner}/${repo}/git/ref/${encodeURIComponent(`heads/${base}`)}`);
  const headSha = ref.object.sha;
  const branch = `atmez-deploy/setup`;
  // create the branch (ignore "already exists")
  await gh(`/repos/${owner}/${repo}/git/refs`, {
    method: "POST",
    body: { ref: `refs/heads/${branch}`, sha: headSha },
  }).catch(() => {});
  for (const f of files) {
    const existing = await gh(`/repos/${owner}/${repo}/contents/${encodeURIComponent(f.path)}?ref=${branch}`);
    await gh(`/repos/${owner}/${repo}/contents/${encodeURIComponent(f.path)}`, {
      method: "PUT",
      body: { message: `ci: add ${f.path}`, content: b64(f.content), sha: existing?.sha, branch },
    });
    console.log(`  staged ${f.path} on ${branch}`);
  }
  const pr = await gh(`/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    body: {
      title,
      head: branch,
      base,
      body:
        "Automated setup by atmez-deploy.\n\n" +
        "This adds a deploy config and a small workflow. After you merge, every push to " +
        "`" + base + "` deploys automatically — no further setup needed.\n\n" +
        "Make sure the deploy secret(s) are set in this repo's Actions secrets.",
    },
  });
  return pr;
}

async function setSecret(owner, repo, name, value, keyCache) {
  if (value == null || value === "") return;
  const pk = keyCache.pk ?? (keyCache.pk = await gh(`/repos/${owner}/${repo}/actions/secrets/public-key`));
  const binkey = sodium.from_base64(pk.key, sodium.base64_variants.ORIGINAL);
  const binval = sodium.from_string(value);
  const enc = sodium.crypto_box_seal(binval, binkey);
  const encrypted_value = sodium.to_base64(enc, sodium.base64_variants.ORIGINAL);
  await gh(`/repos/${owner}/${repo}/actions/secrets/${name}`, {
    method: "PUT",
    body: { encrypted_value, key_id: pk.key_id },
  });
  console.log(`  set secret ${name}`);
}

function callerWorkflow(config, environment, platformRef) {
  return (
    `name: Deploy\n` +
    `on:\n  push:\n    branches: [main]\n  workflow_dispatch:\n\n` +
    `jobs:\n  deploy:\n` +
    `    uses: atmez-deploy/deployment-platform/.github/workflows/_deploy-static.reusable.yml@${platformRef}\n` +
    `    with:\n      config: ${config}\n      environment: ${environment}\n      execute: true\n` +
    `    secrets:\n` +
    `      DEPLOY_SSH_KEY: \${{ secrets.DEPLOY_SSH_KEY }}\n` +
    `      FTP_PASSWORD: \${{ secrets.FTP_PASSWORD }}\n` +
    `      FTP_HOST: \${{ secrets.FTP_HOST }}\n` +
    `      FTP_USERNAME: \${{ secrets.FTP_USERNAME }}\n` +
    `      FTP_WEBROOT: \${{ secrets.FTP_WEBROOT }}\n`
  );
}

function siteConfig({ repoName, domain, auth, environment, webroot, build, outputDir, spa }) {
  // Default webroot: real Hostinger domains live under domains/<domain>/public_html; a
  // primary domain may just be public_html. Caller can override with --webroot.
  const root = webroot || `domains/${domain}/public_html`;
  const targetSsh =
    `    target:\n      driver: hostinger\n      host: \${FTP_HOST}\n      username: \${FTP_USERNAME}\n` +
    `      auth: ssh_key\n      webroot: ${root}\n      transfer: rsync\n`;
  const targetFtps =
    `    target:\n      driver: hostinger\n      host: PLACEHOLDER_or_FTP_HOST_secret\n      port: 21\n` +
    `      username: PLACEHOLDER_or_FTP_USERNAME_secret\n      auth: ftps\n      webroot: ${root}\n      transfer: ftps\n`;
  // build.command: default to a Node build, but allow "" (no build) and a custom command.
  const cmd = build === undefined ? "npm ci && npm run build" : build;
  const out = outputDir || "dist";
  const buildBlock =
    `    build:\n` +
    (cmd ? `      command: ${cmd}\n` : "") +
    `      output_dir: ${out}\n` +
    (spa ? `      spa: true\n` : "");
  return (
    `schema_version: "1.0"\n` +
    `project:\n  name: ${repoName}\n` +
    `repository:\n  organization: atmez-deploy\n  repository: ${repoName}\n` +
    `environments:\n  ${environment}:\n    deployment:\n      type: static\n` +
    (auth === "ssh_key" ? targetSsh : targetFtps) +
    buildBlock +
    `    services:\n      site:\n        exposure:\n          type: domain\n          domain: ${domain}\n          ssl: managed_by_provider\n`
  );
}

function serviceCallerWorkflow(config, platformRef) {
  return (
    `name: Deploy service\n` +
    `on:\n  workflow_dispatch:\n    inputs:\n` +
    `      image: { description: Immutable image ref, required: true }\n` +
    `      environment: { description: Environment, required: false, default: staging }\n` +
    `      service: { description: Service name, required: false, default: backend }\n\n` +
    `jobs:\n  deploy:\n` +
    `    uses: atmez-deploy/deployment-platform/.github/workflows/_deploy-service.reusable.yml@${platformRef}\n` +
    `    with:\n      config: ${config}\n      registry: deploy.registry.yaml\n` +
    `      environment: \${{ github.event.inputs.environment }}\n` +
    `      service: \${{ github.event.inputs.service }}\n      image: \${{ github.event.inputs.image }}\n      execute: true\n` +
    `    secrets:\n      DEPLOY_SSH_KEY: \${{ secrets.DEPLOY_SSH_KEY }}\n`
  );
}

function serviceConfig({ repoName, domain, service, environment, vpsRef }) {
  return (
    `schema_version: "1.0"\n` +
    `project:\n  name: ${repoName}\n` +
    `repository:\n  organization: atmez-deploy\n  repository: ${repoName}\n` +
    `environments:\n  ${environment}:\n    deployment:\n      type: docker\n      strategy: blue_green\n` +
    `    target:\n      driver: vps\n      ref: ${vpsRef}\n` +
    `    services:\n      ${service}:\n` +
    `        exposure:\n          type: domain\n          domain: ${domain}\n          ssl: true\n` +
    `        health:\n          path: /health\n          expect_status: 200\n`
  );
}

async function onboardStatic(owner, repo, o, keyCache) {
  const configPath = "deploy.project.yaml";
  console.log(`onboarding static ${o.repo} (${o.auth}) -> ${o.domain}`);
  const files = [
    { path: configPath, content: siteConfig({ repoName: repo, domain: o.domain, auth: o.auth, environment: o.environment, webroot: o.webroot, build: o.build, outputDir: o.outputDir, spa: o.spa }) },
    { path: ".github/workflows/deploy.yml", content: callerWorkflow(configPath, o.environment, o.platformRef) },
  ];

  if (o.viaPr) {
    // Open a PR instead of pushing to the default branch (needs only PR write, not a
    // direct push to main). The client reviews + merges; the workflow then lives in
    // their repo and CI/CD runs natively on every future push.
    const pr = await openSetupPr(owner, repo, files, "atmez-deploy: set up automated deployment");
    console.log(`  opened PR: ${pr.html_url}`);
    // secrets can be set now (they apply once the workflow merges + runs)
  } else {
    for (const f of files) await putFile(owner, repo, f.path, f.content, `ci: add atmez-deploy ${f.path}`);
  }

  for (const name of ["FTP_PASSWORD", "FTP_HOST", "FTP_USERNAME", "FTP_WEBROOT", "DEPLOY_SSH_KEY"]) {
    await setSecret(owner, repo, name, process.env[name], keyCache);
  }

  if (o.deploy && !o.viaPr) {
    await gh(`/repos/${owner}/${repo}/actions/workflows/deploy.yml/dispatches`, { method: "POST", body: { ref: "main" } })
      .catch((e) => console.warn(`  (first deploy dispatch skipped: ${e.message})`));
    console.log("  triggered first deploy");
  } else if (o.viaPr) {
    console.log("  first deploy will run automatically when the PR is merged (workflow triggers on push to main)");
  }
}

async function onboardService(owner, repo, o, keyCache) {
  if (!o.vpsRef) die("--vps-ref <id> is required for service onboarding (the registry VPS id)");
  const configPath = "deploy.project.yaml";
  console.log(`onboarding service ${o.repo} [${o.service}] on ${o.vpsRef} -> ${o.domain}`);
  await putFile(owner, repo, configPath, serviceConfig({ repoName: repo, domain: o.domain, service: o.service, environment: o.environment, vpsRef: o.vpsRef }), "chore: add atmez-deploy service config");
  await putFile(owner, repo, ".github/workflows/deploy.yml", serviceCallerWorkflow(configPath, o.platformRef), "ci: add atmez-deploy service caller workflow");
  await setSecret(owner, repo, "DEPLOY_SSH_KEY", process.env.DEPLOY_SSH_KEY, keyCache);
  // No auto first-deploy: a service deploy needs an image ref, which the repo's own CI
  // produces. The engineer runs the caller with the image once CI has pushed it.
  console.log("  service onboarded; run the 'Deploy service' workflow with an image ref to deploy");
  console.log("  NOTE: register this project+environment in the registry so a port+domain are allocated");
}

/** Print the files we WOULD add to the client repo, without any API calls. */
function dryRunStatic(repo, o) {
  const configPath = "deploy.project.yaml";
  console.log(`# DRY RUN — files atmez-deploy would add to ${o.repo}\n`);
  console.log(`===== ${configPath} =====`);
  console.log(siteConfig({ repoName: repo, domain: o.domain, auth: o.auth, environment: o.environment, webroot: o.webroot, build: o.build, outputDir: o.outputDir, spa: o.spa }));
  console.log(`===== .github/workflows/deploy.yml =====`);
  console.log(callerWorkflow(configPath, o.environment, o.platformRef));
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const dryRun = process.argv.includes("--dry-run");
  if (!dryRun && !token) die("GH_TOKEN env is required (GitHub App installation token or PAT)");
  if (!o.repo || !o.repo.includes("/")) die("--repo owner/name is required");
  if (!o.domain) die("--domain is required");
  if (!["static", "service"].includes(o.kind)) die("--kind must be 'static' or 'service'");
  const [owner, repo] = o.repo.split("/");

  if (dryRun) {
    if (o.kind === "service") die("--dry-run currently supports --kind static");
    dryRunStatic(repo, o);
    console.log("done (dry run — nothing was changed).");
    return;
  }

  await sodium.ready;
  const keyCache = {};

  if (o.kind === "service") await onboardService(owner, repo, o, keyCache);
  else await onboardStatic(owner, repo, o, keyCache);

  console.log("done.");
}

main().catch((e) => die(e.message));
