// Central project registry (Model B — deploy from OUR repo).
//
// PURE module (Rule 11/14): no cloning, no network, no shell. It loads the projects
// registry object, validates the shape, and resolves ONE project id into:
//   1) clone instructions  — repo URL, branch, and the env var holding a read token
//   2) a deploy config      — the SAME shape the existing static driver/CLI consume,
//                             so Model B reuses the entire engine unchanged.
//
// The impure parts (git clone, build, invoke the engine) live in the workflow +
// engine/cli.mjs, which are already tested. This module just maps registry -> config.

/** Validate an id is a safe slug (no shell/path surprises when used in commands). */
function assertId(id) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(id ?? ""))) {
    throw new Error(`invalid project id: ${JSON.stringify(id)} (use lowercase letters, digits, hyphens)`);
  }
  return id;
}

/** Reject anything that isn't an https/ssh git URL, to avoid cloning surprises. */
function assertRepoUrl(url) {
  const s = String(url ?? "");
  if (!/^(https:\/\/|git@)[\w.@:/~-]+\.git$/.test(s) && !/^https:\/\/[\w.@:/~-]+$/.test(s)) {
    throw new Error(`invalid repo URL: ${JSON.stringify(url)} (expected an https:// or git@ .git URL)`);
  }
  return s;
}

/** Branch/ref: allow normal ref characters only. */
function assertBranch(b) {
  const s = b == null ? "main" : String(b);
  if (!/^[\w./-]+$/.test(s)) throw new Error(`invalid branch/ref: ${JSON.stringify(b)}`);
  return s;
}

/**
 * List all project ids in a registry object (for the workflow's dropdown / validation).
 * @param {object} registry parsed projects.yaml
 * @returns {string[]}
 */
export function listProjectIds(registry) {
  const list = registry?.projects;
  if (!Array.isArray(list)) throw new Error("projects registry: 'projects' must be a list");
  return list.map((p) => p.id);
}

/**
 * Resolve one project id into clone instructions + a deploy config the engine consumes.
 * @param {object} registry parsed projects.yaml
 * @param {string} id       the project id to resolve
 * @returns {{
 *   id: string,
 *   clone: { repo: string, branch: string, tokenRef: string|null },
 *   build: { command: string|null, outputDir: string|null, image: string|null },
 *   deployConfig: object,   // { schema_version, project, repository, environments: { production: {...} } }
 *   environment: string,    // always "production" for the resolved config
 *   secretRef: string       // env var name holding the deploy credential
 * }}
 */
export function resolveProject(registry, id) {
  assertId(id);
  const list = registry?.projects;
  if (!Array.isArray(list)) throw new Error("projects registry: 'projects' must be a list");

  const p = list.find((x) => x.id === id);
  if (!p) {
    const known = list.map((x) => x.id).join(", ") || "(none)";
    throw new Error(`unknown project id '${id}'. Known ids: ${known}`);
  }

  const repo = assertRepoUrl(p.repo);
  const branch = assertBranch(p.branch);
  const tokenRef = p.repo_token_ref ?? null;
  if (tokenRef != null && !/^[A-Z][A-Z0-9_]*$/.test(String(tokenRef))) {
    throw new Error(`invalid repo_token_ref '${tokenRef}' (must be an ENV_VAR-style name)`);
  }

  const t = p.target;
  if (!t?.driver) throw new Error(`project '${id}': target.driver is required`);
  if (!t.secret_ref) throw new Error(`project '${id}': target.secret_ref is required`);
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(String(t.secret_ref))) {
    throw new Error(`project '${id}': invalid target.secret_ref '${t.secret_ref}'`);
  }
  if (!t.webroot) throw new Error(`project '${id}': target.webroot is required`);

  const build = p.build ?? {};

  // Build the exact environment shape the static driver + CLI already understand, so we
  // don't special-case Model B anywhere in the engine.
  const deployConfig = {
    schema_version: registry.schema_version ?? "1.0",
    project: { name: id, owner: p.owner ?? "platform-team" },
    repository: {
      organization: "atmez-deploy",
      repository: "deployment-platform",
      default_branch: "main",
    },
    environments: {
      production: {
        deployment: { type: "static" },
        target: {
          driver: t.driver,
          host: t.host,
          port: t.port,
          username: t.username,
          auth: t.auth,
          webroot: t.webroot,
          transfer: t.transfer,
          secret_ref: t.secret_ref,
        },
        build: {
          ...(build.command ? { command: build.command } : {}),
          ...(build.image ? { image: build.image } : {}),
          ...(build.output_dir ? { output_dir: build.output_dir } : {}),
          ...(build.spa === true ? { spa: true } : {}),
          ...(typeof build.htaccess === "string" ? { htaccess: build.htaccess } : {}),
        },
        services: {
          site: {
            exposure: {
              type: "domain",
              domain: p.exposure?.domain,
              ssl: p.exposure?.ssl ?? "managed_by_provider",
            },
          },
        },
      },
    },
  };

  return {
    id,
    clone: { repo, branch, tokenRef },
    build: {
      command: build.command ?? null,
      outputDir: build.output_dir ?? null,
      image: build.image ?? null,
    },
    deployConfig,
    environment: "production",
    secretRef: t.secret_ref,
  };
}
