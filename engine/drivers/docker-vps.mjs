// VPS Docker blue/green publisher — compose-based, modeled on the real acadlynk layout.
// PURE: emits a deterministic step plan. The executor turns steps into ssh + docker
// compose + nginx + certbot commands; the runner executes only when told to.
//
// Layout on the VPS (matches acadlynk):
//   /opt/<project>/
//     blue/docker-compose.app.yml     green/docker-compose.app.yml
//     shared/<service>.env  shared/uploads
//     db/docker-compose.db.yml  db/.env
//     active_env                      (marker: blue|green)
//
// Deploy = bring the IDLE color up via compose, health-check it, point nginx at it,
// reload, (first time) obtain SSL via certbot, verify live. Both colors stay running
// (like acadlynk). Rollback = repoint nginx at the other color + reload.

import { networkName, nginxConfName, otherColor } from "../naming.mjs";
import { renderAppCompose, renderDbCompose } from "../compose.mjs";
import { renderProjectNginx } from "../nginx.mjs";

const NGINX_SITES_AVAILABLE = "/etc/nginx/sites-available";
const NGINX_SITES_ENABLED = "/etc/nginx/sites-enabled";

function assertImageRef(ref) {
  if (!/^[\w./-]+(:[\w.-]+|@sha256:[a-f0-9]{64})$/.test(String(ref ?? ""))) {
    throw new Error(`invalid image reference: ${ref}`);
  }
  return ref;
}

/**
 * @param {Object} args
 * @param {string} args.project
 * @param {string} args.environment
 * @param {Array}  args.services  [{ name, role?, image, containerPort, hostPortBlue, hostPortGreen, domain?, ssl?, envFromSecret?, volumes? }]
 *   Each service is bound to a different host port per color (both colors run at once).
 * @param {Object} [args.db]        { enabled, image?, hostPort?, volumeName? }
 * @param {string} [args.basePath]  default /opt
 * @param {Object} [args.migrate]   { service, command }
 * @param {string} [args.uploadsSubdir] default "uploads"
 */
export function planDeploy({
  project,
  environment,
  services,
  db = {},
  basePath = "/opt",
  migrate = null,
  uploadsSubdir = "uploads",
}) {
  if (!project || !environment) throw new Error("project/environment required");
  if (!Array.isArray(services) || services.length === 0) throw new Error("services required");
  for (const s of services) assertImageRef(s.image);

  const projectRoot = `${basePath}/${project}`.replace(/\/+/g, "/");
  const sharedDir = `${projectRoot}/shared`;
  const uploadsPath = `${sharedDir}/${uploadsSubdir}`;
  const network = networkName(project, environment);
  const confName = nginxConfName(project, environment, "site").replace(/-site\.conf$/, ".conf");
  const availPath = `${NGINX_SITES_AVAILABLE}/${project}`;
  const enabledPath = `${NGINX_SITES_ENABLED}/${project}`;
  const markerPath = `${projectRoot}/active_env`;

  // Any domain-exposed service that requests real SSL means we run certbot.
  const sslDomains = services.filter((s) => s.domain && s.ssl === true).map((s) => s.domain);

  // Compose text is precomputed per color (host ports differ per color).
  const composeFor = (color) =>
    renderAppCompose({
      project,
      color,
      network,
      services: services.map((s) => ({
        name: s.name,
        image: s.image,
        containerPort: s.containerPort,
        hostPort: color === "blue" ? s.hostPortBlue : s.hostPortGreen,
        envFile: s.envFromSecret ? `../shared/${s.name}.env` : undefined,
        volumes: s.volumes,
      })),
    });

  // nginx blocks for the IDLE color's ports (executor picks per resolved color at run time;
  // for the plan we precompute both and let the executor choose).
  const nginxFor = (color) => {
    const backend = services.find((s) => (s.role ?? s.name) === "backend" || s.name === "backend");
    const backendPort = backend ? (color === "blue" ? backend.hostPortBlue : backend.hostPortGreen) : undefined;
    const blocks = services
      .filter((s) => s.domain)
      .map((s) => ({
        service: s.name,
        role: s.role,
        domain: s.domain,
        port: color === "blue" ? s.hostPortBlue : s.hostPortGreen,
        backendPort: (s.role ?? s.name) === "admin" ? backendPort : undefined,
      }));
    return renderProjectNginx({ project, uploadsPath, blocks });
  };

  const steps = [
    { type: "determine_active", markerPath, note: "read current live color (default blue)" },
    {
      type: "ensure_dirs",
      dirs: [`${projectRoot}/blue`, `${projectRoot}/green`, sharedDir, uploadsPath, `${projectRoot}/db`],
      note: "create the project directory layout",
    },
    { type: "ensure_network", network, note: "create the external docker network if missing" },
  ];

  if (db.enabled) {
    steps.push(
      {
        type: "write_file",
        path: `${projectRoot}/db/docker-compose.db.yml`,
        content: renderDbCompose({ project, network, db }),
        note: "write DB compose",
      },
      {
        type: "compose_up",
        file: `${projectRoot}/db/docker-compose.db.yml`,
        envFile: `${projectRoot}/db/.env`,
        note: "start the database (idempotent)",
      },
    );
  }

  // Write shared env files for services that inject secrets (content filled by executor
  // from env at run time; here we only record which files must exist).
  for (const s of services.filter((x) => x.envFromSecret)) {
    steps.push({
      type: "write_env",
      path: `${sharedDir}/${s.name}.env`,
      secretName: s.envFromSecret, // env var holding the full .env contents
      note: `write shared env for ${s.name} from secret`,
    });
  }

  steps.push(
    {
      type: "write_compose",
      blueFile: `${projectRoot}/blue/docker-compose.app.yml`,
      greenFile: `${projectRoot}/green/docker-compose.app.yml`,
      blueContent: composeFor("blue"),
      greenContent: composeFor("green"),
      note: "write both per-color compose files",
    },
    { type: "compose_pull_idle", projectRoot, note: "pull images for the idle color" },
    { type: "compose_up_idle", projectRoot, note: "start the idle color" },
  );

  if (migrate?.command) {
    steps.push({
      type: "migrate",
      service: migrate.service ?? "backend",
      command: migrate.command,
      note: "run migrations in the idle color's container",
    });
  }

  // Health check the idle color by PORT (no traffic yet). SSL-aware live check comes later.
  steps.push(
    {
      type: "health_check_idle",
      services: services.filter((s) => s.domain).map((s) => ({ name: s.name, blue: s.hostPortBlue, green: s.hostPortGreen, path: s.healthPath ?? "/" })),
      note: "probe idle color containers on their ports",
    },
    {
      type: "nginx_write",
      availPath,
      enabledPath,
      blueContent: nginxFor("blue"),
      greenContent: nginxFor("green"),
      note: "write nginx pointing at the idle color (HTTP first)",
    },
    { type: "nginx_reload", note: "nginx -t && reload — atomic traffic switch to idle color" },
  );

  if (sslDomains.length > 0) {
    steps.push({
      type: "certbot",
      domains: sslDomains,
      note: "obtain/renew SSL (idempotent; skips if cert exists), then reload nginx",
    });
  }

  steps.push(
    {
      type: "verify_live",
      checks: services
        .filter((s) => s.domain)
        .map((s) => ({ domain: s.domain, ssl: s.ssl === true, port: null, path: s.healthPath ?? "/" })),
      note: "verify each domain live (https if ssl, else http via port)",
    },
    { type: "write_active_marker", markerPath, note: "record the newly-live color" },
  );

  return {
    driver: "docker-vps",
    mode: "compose-blue-green",
    identity: { project, environment, projectRoot, network, availPath, enabledPath, markerPath },
    steps,
  };
}

/**
 * Rollback: repoint nginx at the other (previous) color and reload. Both colors are
 * still running, so this is an instant switch.
 */
export function planRollback({ project, environment, services, basePath = "/opt", uploadsSubdir = "uploads" }) {
  if (!project || !environment) throw new Error("project/environment required");
  if (!Array.isArray(services) || services.length === 0) throw new Error("services required");

  const projectRoot = `${basePath}/${project}`.replace(/\/+/g, "/");
  const uploadsPath = `${projectRoot}/shared/${uploadsSubdir}`;
  const availPath = `${NGINX_SITES_AVAILABLE}/${project}`;
  const enabledPath = `${NGINX_SITES_ENABLED}/${project}`;
  const markerPath = `${projectRoot}/active_env`;

  const nginxFor = (color) => {
    const backend = services.find((s) => (s.role ?? s.name) === "backend" || s.name === "backend");
    const backendPort = backend ? (color === "blue" ? backend.hostPortBlue : backend.hostPortGreen) : undefined;
    const blocks = services
      .filter((s) => s.domain)
      .map((s) => ({
        service: s.name,
        role: s.role,
        domain: s.domain,
        port: color === "blue" ? s.hostPortBlue : s.hostPortGreen,
        backendPort: (s.role ?? s.name) === "admin" ? backendPort : undefined,
      }));
    return renderProjectNginx({ project, uploadsPath, blocks });
  };

  return {
    driver: "docker-vps",
    mode: "compose-blue-green",
    identity: { project, environment, projectRoot, availPath, enabledPath, markerPath },
    steps: [
      { type: "determine_active", markerPath, note: "find current (bad) color" },
      { type: "assert_other_up", note: "ensure the previous color is still running" },
      {
        type: "nginx_write",
        availPath,
        enabledPath,
        blueContent: nginxFor("blue"),
        greenContent: nginxFor("green"),
        note: "point nginx at the previous color",
      },
      { type: "nginx_reload", note: "atomic switch back" },
      {
        type: "verify_live",
        checks: services.filter((s) => s.domain).map((s) => ({ domain: s.domain, ssl: s.ssl === true, path: s.healthPath ?? "/" })),
        note: "confirm restored",
      },
      { type: "write_active_marker", markerPath, note: "record the restored color" },
    ],
  };
}
