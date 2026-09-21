// Deep preflight gate — verify EVERYTHING is correct before a deploy proceeds.
//
// PURE: given a resolved project config, the chosen environment, the set of secret NAMES
// that are present (not their values), and the runtime inputs (branch, image, ...), it
// returns a structured report of checks. The caller refuses to deploy unless report.ok.
//
// It validates three layers:
//   1. config coherence  — environment exists; deployment/target/build fields are sane
//   2. required inputs    — the runtime values this deployment kind needs (image for docker,
//                           dir for static, environment always)
//   3. required secrets   — the credential secrets that must be set for this target
//
// This is separate from platforms.preflight() (which drives the interactive platform
// picker). This one gates a concrete deploy of a concrete config.

/** A single check result. */
function check(name, ok, detail) {
  return { name, ok: !!ok, detail: detail || "" };
}

/** Which secret names a target requires / accepts. */
export function requiredSecretsFor(target) {
  const driver = target?.driver;
  if (driver === "hostinger") {
    if (target.auth === "ftps") {
      return { required: ["FTP_PASSWORD"], optional: ["DEPLOY_HOST", "DEPLOY_USERNAME", "DEPLOY_WEBROOT", "FTP_HOST", "FTP_USERNAME", "FTP_WEBROOT"] };
    }
    // ssh_key
    return { required: ["DEPLOY_SSH_KEY"], optional: ["DEPLOY_HOST", "DEPLOY_USERNAME", "DEPLOY_WEBROOT", "FTP_HOST", "FTP_USERNAME"] };
  }
  if (driver === "vps") {
    return { required: ["DEPLOY_SSH_KEY"], optional: [] };
  }
  if (driver === "cpanel") {
    return { required: ["CPANEL_API_TOKEN"], optional: ["FTP_PASSWORD"] };
  }
  return { required: [], optional: [] };
}

/**
 * Run the deep preflight.
 * @param {Object} args
 * @param {object} args.config          the full project config (parsed)
 * @param {string} args.environment     chosen environment name
 * @param {string[]} [args.presentSecrets=[]]  names of secrets that ARE set (values not needed)
 * @param {object} [args.inputs={}]      runtime inputs: { branch, image, dir, ... }
 * @returns {{ok:boolean, checks:object[], failures:string[]}}
 */
export function runPreflight({ config, environment, presentSecrets = [], inputs = {} }) {
  const checks = [];
  const has = (name) => presentSecrets.includes(name);

  // ---- Layer 1: config coherence ----
  const envs = config?.environments || {};
  const env = envs[environment];
  checks.push(check(`environment "${environment}" exists`, !!env,
    env ? "" : `known: ${Object.keys(envs).join(", ") || "(none)"}`));
  if (!env) {
    // Can't validate further without an environment; return early with what we have.
    return finalize(checks);
  }

  const type = env.deployment?.type;
  checks.push(check("deployment.type is set", type === "static" || type === "docker",
    type ? `type=${type}` : "missing deployment.type"));

  const target = env.target || {};
  checks.push(check("target.driver is set", !!target.driver, target.driver ? `driver=${target.driver}` : "missing"));

  if (type === "static") {
    // static needs a build block (schema enforces it too) and a webroot on hostinger
    checks.push(check("build block present", !!env.build, env.build ? "" : "static requires build"));
    if (target.driver === "hostinger") {
      const webrootOk = !!(target.webroot || has("DEPLOY_WEBROOT") || has("FTP_WEBROOT"));
      checks.push(check("webroot resolvable", webrootOk, webrootOk ? "" : "set target.webroot or DEPLOY_WEBROOT secret"));
    }
  }

  if (type === "docker") {
    checks.push(check("target.driver is vps", target.driver === "vps",
      target.driver === "vps" ? "" : "docker deployments require a vps target"));
    checks.push(check("target.ref is set", !!target.ref, target.ref ? `ref=${target.ref}` : "missing registry vps id"));
    const services = env.services || {};
    checks.push(check("at least one service", Object.keys(services).length > 0, ""));
  }

  // ---- Layer 2: required runtime inputs ----
  checks.push(check("environment input provided", !!environment, ""));
  if (inputs.branch !== undefined) {
    checks.push(check("branch is a valid ref", /^[\w./-]+$/.test(String(inputs.branch)),
      `branch=${inputs.branch}`));
  }
  if (type === "docker") {
    checks.push(check("image ref provided", !!inputs.image, inputs.image ? "" : "docker deploy needs an --image"));
    if (inputs.image) {
      const ok = /^[\w./-]+(:[\w.-]+|@sha256:[a-f0-9]{64})$/.test(String(inputs.image));
      checks.push(check("image ref is immutable/well-formed", ok, ok ? "" : "use name:tag or name@sha256:..."));
    }
  }
  if (type === "static") {
    checks.push(check("build dir provided", !!inputs.dir, inputs.dir ? `dir=${inputs.dir}` : "static deploy needs a --dir"));
  }

  // ---- Layer 3: required secrets ----
  const { required } = requiredSecretsFor(target);
  for (const name of required) {
    checks.push(check(`secret ${name} is set`, has(name), has(name) ? "" : "add it to the repo's Actions secrets"));
  }

  return finalize(checks);
}

function finalize(checks) {
  const failures = checks.filter((c) => !c.ok).map((c) => c.name);
  return { ok: failures.length === 0, checks, failures };
}
