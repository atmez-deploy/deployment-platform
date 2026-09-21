#!/usr/bin/env node
// Onboard a site repo automatically. Given a target repo, this:
//   0) CHECKS PREREQUISITES first (repo access + required inputs) and refuses to proceed
//      if anything is missing — see checkPrerequisites()
//   1) writes the caller workflow (.github/workflows/deploy.yml) into the repo
//   2) writes the site's deploy.project.yaml config into the repo
//   3) sets the repo's secrets (DEPLOY_HOST / DEPLOY_USERNAME / DEPLOY_SSH_KEY / FTP_PASSWORD)
//   4) optionally triggers the first deploy
//
// It uses the GitHub REST API. Auth comes from GH_TOKEN in the env (a GitHub App
// installation token or a PAT with contents+secrets+actions write on the target repo).
// NOTHING is hardcoded; secret VALUES are read from env and never logged.
//
// ACCESS is a prerequisite collected up front: the client grants Write access (collaborator
// or GitHub App), OR use --via-pr to open a PR they merge (needs less access).
//
// Usage:
//   GH_TOKEN=... node tools/onboard.mjs \
//     --repo owner/name --domain www.example.com --auth ssh_key \
//     [--webroot domains/www.example.com/public_html] \
//     [--build "npm ci && npm run build"] [--output-dir dist] [--spa] \
//     [--platform-ref main] [--via-pr] [--no-deploy] [--check-only] [--dry-run]
//
//   --check-only -> verify prerequisites (access + inputs) and stop, without writing.
//   --dry-run    -> print the files we WOULD add, without any API calls.
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
//   DEPLOY_HOST, DEPLOY_USERNAME, DEPLOY_WEBROOT, DEPLOY_SSH_KEY, FTP_PASSWORD
//   (legacy FTP_HOST/FTP_USERNAME/FTP_WEBROOT are still read as a fallback source)

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
    else if (a === "--branch") o.branch = argv[++i];       // client branch to auto-deploy on (default main)
    else if (a === "--dockerfile") o.dockerfile = argv[++i]; // service Dockerfile path (default Dockerfile)
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

/**
 * Verify the onboarding PREREQUISITES before writing anything. Fails early with a clear,
 * actionable message so we never half-onboard. Checks:
 *   1) the token is present
 *   2) the repo exists and the token can read it (else: not found / no access)
 *   3) the token has WRITE access (repo.permissions.push) — required to create the files
 *      (or open a PR); if only read, tell the user exactly what to grant
 *   4) the required deploy inputs for the chosen kind are present (domain, and for a
 *      service: the VPS ref)
 * Returns nothing on success; calls die() with guidance on failure.
 */
async function checkPrerequisites(owner, repo, o) {
  console.log(`# checking prerequisites for ${o.repo} ...`);

  if (!token) {
    die(
      "no GH_TOKEN. We need a token with write access to the client repo.\n" +
        "  How to get it: ask the client to either (a) add us as a repo collaborator with\n" +
        "  Write access, or (b) install our GitHub App on the repo. Then set GH_TOKEN to a\n" +
        "  token for that access.",
    );
  }

  // 2 + 3: read the repo and inspect our permission level.
  const info = await gh(`/repos/${owner}/${repo}`);
  if (!info) {
    die(
      `cannot access ${o.repo} (not found, or the token has no access).\n` +
        "  Fix: confirm the repo name is 'owner/name', and that the client granted us access\n" +
        "  (collaborator with Write, or GitHub App installed on this repo).",
    );
  }
  console.log(`  OK   repo reachable (default branch: ${info.default_branch})`);

  const canPush = info.permissions?.push === true || info.permissions?.admin === true;
  const canPr = info.permissions?.pull === true; // PRs need at least read + fork/branch write
  if (o.viaPr) {
    if (!canPush && !canPr) {
      die(
        "the token cannot open a pull request on this repo.\n" +
          "  Fix: ask the client for at least Write access (or install the GitHub App), then retry.",
      );
    }
    console.log("  OK   can open a pull request (--via-pr)");
  } else {
    if (!canPush) {
      die(
        "the token has READ-only access; it cannot write files to the repo.\n" +
          "  Fix options:\n" +
          "    - ask the client to grant Write access (Settings -> Collaborators), OR\n" +
          "    - re-run with --via-pr to open a Pull Request they merge (needs less access).",
      );
    }
    console.log("  OK   can write files (Write access confirmed)");
  }

  // 4: required inputs for the chosen kind.
  if (!o.domain) die("missing --domain (the site/service domain).");
  console.log(`  OK   domain: ${o.domain}`);
  if (o.kind === "service" && !o.vpsRef) {
    die("missing --vps-ref (the registry VPS id the backend deploys to).");
  }
  if (o.kind === "service") console.log(`  OK   vps ref: ${o.vpsRef}`);

  console.log("  prerequisites OK.\n");
}

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
    `      DEPLOY_HOST: \${{ secrets.DEPLOY_HOST }}\n` +
    `      DEPLOY_USERNAME: \${{ secrets.DEPLOY_USERNAME }}\n` +
    `      DEPLOY_WEBROOT: \${{ secrets.DEPLOY_WEBROOT }}\n` +
    `      FTP_PASSWORD: \${{ secrets.FTP_PASSWORD }}\n`
  );
}

function siteConfig({ repoName, domain, auth, environment, webroot, build, outputDir, spa }) {
  // Default webroot: real Hostinger domains live under domains/<domain>/public_html; a
  // primary domain may just be public_html. Caller can override with --webroot.
  const root = webroot || `domains/${domain}/public_html`;
  const targetSsh =
    `    target:\n      driver: hostinger\n      host: \${DEPLOY_HOST}\n      username: \${DEPLOY_USERNAME}\n` +
    `      auth: ssh_key\n      webroot: ${root}\n      transfer: rsync\n`;
  const targetFtps =
    `    target:\n      driver: hostinger\n      host: \${DEPLOY_HOST}\n      port: 21\n` +
    `      username: \${DEPLOY_USERNAME}\n      auth: ftps\n      webroot: ${root}\n      transfer: ftps\n`;
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

function serviceCallerWorkflow(config, platformRef, { service, environment, branch, dockerfile }) {
  const br = branch || "main";
  const df = dockerfile || "Dockerfile";
  // Full push-triggered backend CI/CD, in the CLIENT's repo:
  //   1) build the Docker image from their code
  //   2) push it to GHCR as an immutable ref (tagged with the commit sha)
  //   3) call our reusable workflow to blue/green deploy that exact image to the VPS
  // So every push to their branch auto-deploys, just like a static site.
  return (
    `name: Deploy service\n` +
    `on:\n` +
    `  push:\n    branches: [${br}]\n` +
    `  workflow_dispatch:\n` +
    `    inputs:\n` +
    `      environment: { description: Environment, required: false, default: ${environment} }\n` +
    `      service: { description: Service name, required: false, default: ${service} }\n\n` +
    `permissions:\n  contents: read\n  packages: write\n\n` +
    `jobs:\n` +
    `  build:\n` +
    `    runs-on: ubuntu-latest\n` +
    `    outputs:\n      image: \${{ steps.meta.outputs.image }}\n` +
    `    steps:\n` +
    `      - uses: actions/checkout@v4\n` +
    `      - name: Log in to GHCR\n` +
    `        uses: docker/login-action@v3\n` +
    `        with:\n          registry: ghcr.io\n          username: \${{ github.actor }}\n          password: \${{ secrets.GITHUB_TOKEN }}\n` +
    `      - name: Compute image ref\n        id: meta\n` +
    `        run: echo "image=ghcr.io/\${{ github.repository }}-${service}:\${{ github.sha }}" >> "$GITHUB_OUTPUT"\n` +
    `      - name: Build and push\n` +
    `        uses: docker/build-push-action@v6\n` +
    `        with:\n          context: .\n          file: ${df}\n          push: true\n          tags: \${{ steps.meta.outputs.image }}\n\n` +
    `  deploy:\n` +
    `    needs: build\n` +
    `    uses: atmez-deploy/deployment-platform/.github/workflows/_deploy-service.reusable.yml@${platformRef}\n` +
    `    with:\n` +
    `      config: ${config}\n` +
    `      registry: deploy.registry.yaml\n` +
    `      environment: \${{ github.event.inputs.environment || '${environment}' }}\n` +
    `      service: \${{ github.event.inputs.service || '${service}' }}\n` +
    `      image: \${{ needs.build.outputs.image }}\n` +
    `      execute: true\n` +
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

  // Set the transport-neutral connection secrets plus the (ftp-only) password + ssh key.
  // Values are read from env; DEPLOY_* fall back to the legacy FTP_* env if only those are set.
  const secretEnv = {
    DEPLOY_HOST: process.env.DEPLOY_HOST || process.env.FTP_HOST,
    DEPLOY_USERNAME: process.env.DEPLOY_USERNAME || process.env.FTP_USERNAME,
    DEPLOY_WEBROOT: process.env.DEPLOY_WEBROOT || process.env.FTP_WEBROOT,
    FTP_PASSWORD: process.env.FTP_PASSWORD,
    DEPLOY_SSH_KEY: process.env.DEPLOY_SSH_KEY,
  };
  for (const [name, value] of Object.entries(secretEnv)) {
    await setSecret(owner, repo, name, value, keyCache);
  }

  if (o.deploy && !o.viaPr) {
    await gh(`/repos/${owner}/${repo}/actions/workflows/deploy.yml/dispatches`, { method: "POST", body: { ref: "main" } })
      .catch((e) => console.warn(`  (first deploy dispatch skipped: ${e.message})`));
    console.log("  triggered first deploy");
  } else if (o.viaPr) {
    console.log("  first deploy will run automatically when the PR is merged (workflow triggers on push to main)");
  }
}

function serviceFiles(repo, o) {
  const configPath = "deploy.project.yaml";
  return [
    { path: configPath, content: serviceConfig({ repoName: repo, domain: o.domain, service: o.service, environment: o.environment, vpsRef: o.vpsRef }) },
    {
      path: ".github/workflows/deploy.yml",
      content: serviceCallerWorkflow(configPath, o.platformRef, {
        service: o.service,
        environment: o.environment,
        branch: o.branch,
        dockerfile: o.dockerfile,
      }),
    },
  ];
}

async function onboardService(owner, repo, o, keyCache) {
  if (!o.vpsRef) die("--vps-ref <id> is required for service onboarding (the registry VPS id)");
  console.log(`onboarding service ${o.repo} [${o.service}] on ${o.vpsRef} -> ${o.domain}`);
  const files = serviceFiles(repo, o);

  if (o.viaPr) {
    const pr = await openSetupPr(owner, repo, files, "atmez-deploy: set up backend CI/CD (build + blue/green deploy)");
    console.log(`  opened PR: ${pr.html_url}`);
  } else {
    for (const f of files) await putFile(owner, repo, f.path, f.content, `ci: add atmez-deploy ${f.path}`);
  }

  await setSecret(owner, repo, "DEPLOY_SSH_KEY", process.env.DEPLOY_SSH_KEY, keyCache);

  // Backends need resources allocated (port + domain) BEFORE the first deploy. This is a
  // one-time registry step on OUR side — the client's repo then auto-deploys on every push.
  console.log("");
  console.log("  IMPORTANT — one-time registry step (on the platform side), before the first deploy:");
  console.log(`    node engine/cli.mjs register --config <this-config> --env ${o.environment} --registry <registry.yaml> --execute`);
  console.log("  After that, every push to the client's branch builds the image and blue/green-deploys it.");
  if (o.viaPr) console.log("  (the workflow starts working once the PR is merged)");
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

/** Dry-run preview for a backend service onboarding. */
function dryRunService(repo, o) {
  if (!o.vpsRef) die("--vps-ref <id> is required for service onboarding");
  console.log(`# DRY RUN — files atmez-deploy would add to ${o.repo} (backend service)\n`);
  for (const f of serviceFiles(repo, o)) {
    console.log(`===== ${f.path} =====`);
    console.log(f.content);
  }
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const dryRun = process.argv.includes("--dry-run");
  const checkOnly = process.argv.includes("--check-only");
  // --dry-run needs no token; --check-only handles the missing-token case with guidance.
  if (!dryRun && !checkOnly && !token) die("GH_TOKEN env is required (GitHub App installation token or PAT)");
  if (!o.repo || !o.repo.includes("/")) die("--repo owner/name is required");
  if (!o.domain) die("--domain is required");
  if (!["static", "service"].includes(o.kind)) die("--kind must be 'static' or 'service'");
  const [owner, repo] = o.repo.split("/");

  if (dryRun) {
    if (o.kind === "service") dryRunService(repo, o);
    else dryRunStatic(repo, o);
    console.log("done (dry run — nothing was changed).");
    return;
  }

  // Prerequisite gate — verify access + inputs BEFORE touching the repo.
  await checkPrerequisites(owner, repo, o);
  if (checkOnly) {
    console.log("check-only: prerequisites satisfied. Re-run without --check-only to onboard.");
    return;
  }

  await sodium.ready;
  const keyCache = {};

  if (o.kind === "service") await onboardService(owner, repo, o, keyCache);
  else await onboardStatic(owner, repo, o, keyCache);

  console.log("done.");
}

main().catch((e) => die(e.message));
