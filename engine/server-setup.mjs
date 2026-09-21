// One-time SERVER setup for a VPS target (Model: "we set up the server once; the client's
// repo runs everything after"). PURE: emits a deterministic, idempotent step plan. The
// executor turns steps into ssh commands; the runner executes only with --execute.
//
// What it prepares (all idempotent — safe to re-run):
//   1. base packages: Docker engine + compose plugin, nginx, certbot (+ nginx plugin)
//   2. enable + start docker and nginx
//   3. a deploy user (optional) with docker group access
//   4. authorize the deploy public key for that user (append if missing)
//   5. base deployment directory (e.g. /opt) owned by the deploy user
//
// It does NOT allocate ports/domains — that's the `register` command (it mutates our
// registry). And it does NOT write the project's nginx conf — the first deploy's
// bootstrap_nginx_if_missing step does that (then certbot adds SSL).
//
// Everything here is standard, transparent server prep; nothing project-specific and no
// secrets embedded (the public key is not secret).

/** A deploy username must be a safe unix name. */
function assertUser(name) {
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(String(name ?? ""))) {
    throw new Error(`invalid deploy user name: ${name}`);
  }
  return name;
}

/**
 * Build the server-setup plan.
 * @param {Object} args
 * @param {string} [args.basePath="/opt"]  root under which project deployments live
 * @param {string} [args.deployUser]       optional non-root deploy user to create
 * @param {string} [args.publicKey]        the deploy PUBLIC key to authorize for that user
 * @param {boolean}[args.installPackages=true]  install docker/nginx/certbot
 * @returns {{driver:string, mode:string, steps: object[]}}
 */
export function planServerSetup({
  basePath = "/opt",
  deployUser,
  publicKey,
  installPackages = true,
} = {}) {
  if (deployUser) assertUser(deployUser);
  const steps = [];

  if (installPackages) {
    // Idempotent install. `apt-get install` is a no-op if already present. Docker via the
    // official convenience script only when docker is missing; compose plugin + nginx +
    // certbot via apt.
    steps.push({
      type: "run",
      label: "install docker (if missing)",
      command:
        "command -v docker >/dev/null 2>&1 || (curl -fsSL https://get.docker.com | sh)",
    });
    steps.push({
      type: "run",
      label: "install nginx + certbot",
      command:
        "export DEBIAN_FRONTEND=noninteractive; apt-get update -y && " +
        "apt-get install -y nginx certbot python3-certbot-nginx",
    });
    steps.push({
      type: "run",
      label: "enable + start docker and nginx",
      command: "systemctl enable --now docker; systemctl enable --now nginx",
    });
  }

  if (deployUser) {
    steps.push({
      type: "run",
      label: `ensure deploy user ${deployUser}`,
      command:
        `id -u ${deployUser} >/dev/null 2>&1 || useradd -m -s /bin/bash ${deployUser}; ` +
        `usermod -aG docker ${deployUser}`,
    });
    if (publicKey) {
      // Append the public key to authorized_keys only if it's not already there.
      const home = `/home/${deployUser}`;
      steps.push({
        type: "run",
        label: `authorize deploy key for ${deployUser}`,
        command:
          `install -d -m 700 -o ${deployUser} -g ${deployUser} ${home}/.ssh && ` +
          `touch ${home}/.ssh/authorized_keys && ` +
          `grep -qF ${shSingleQuote(publicKey)} ${home}/.ssh/authorized_keys || ` +
          `echo ${shSingleQuote(publicKey)} >> ${home}/.ssh/authorized_keys; ` +
          `chown ${deployUser}:${deployUser} ${home}/.ssh/authorized_keys && ` +
          `chmod 600 ${home}/.ssh/authorized_keys`,
      });
    }
  }

  // Base deployment directory. If a deploy user exists, hand it ownership.
  const owner = deployUser ? `${deployUser}:${deployUser}` : "root:root";
  steps.push({
    type: "run",
    label: `ensure base path ${basePath}`,
    command: `mkdir -p ${basePath} && chown ${owner} ${basePath}`,
  });

  return { driver: "server-setup", mode: "vps-prep", steps };
}

/** Single-quote a value for safe embedding in a remote sh command. */
function shSingleQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
