// VPS Docker blue/green publisher — models the real deploy-backend.sh flow, generically.
// PURE: emits a deterministic step plan. The executor turns steps into ssh + docker
// compose + nginx + certbot commands; the runner executes only when told to.
//
// Flow (mirrors deploy-backend.sh, but driven by config/registry for ANY project):
//   1. read active_env -> TARGET = idle color, OLD = current color
//   2. compose -p <project>-<TARGET> pull, then up -d --force-recreate
//   3. run migrations (optional) in the TARGET backend container
//   4. health-check each service on its TARGET port (backend /api/health, others /)
//   5. FIRST TIME ONLY: if the nginx conf doesn't exist, write the HTTP config + run
//      certbot to add SSL. On subsequent deploys the conf already has SSL — we DON'T
//      rewrite it (that would wipe Certbot's lines); we only swap the port numbers.
//   6. switch: sed `set $<svc>_port N;` in the existing conf to the TARGET ports, reload
//   7. write active_env = TARGET
//   8. verify live (https://<domain> per service)
//   9. compose -p <project>-<OLD> down  (bring the old color down)
//
// Layout on the VPS matches acadlynk: /opt/<project>/{blue,green,shared,db}, active_env.

import { networkName } from "../naming.mjs";
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

/** Default health path per role: backend -> /api/health, everything else -> / */
function healthPathFor(service) {
  if (service.healthPath) return service.healthPath;
  const role = service.role ?? service.name;
  return role === "backend" || role === "api" ? "/api/health" : "/";
}

/**
 * @param {Object} args
 * @param {string} args.project
 * @param {string} args.environment
 * @param {Array}  args.services  [{ name, role?, image, containerPort, hostPortBlue, hostPortGreen, domain?, ssl?, envFromSecret?, volumes?, healthPath? }]
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
  const availPath = `${NGINX_SITES_AVAILABLE}/${project}`;
  const enabledPath = `${NGINX_SITES_ENABLED}/${project}`;
  const markerPath = `${projectRoot}/active_env`;

  const domainServices = services.filter((s) => s.domain);
  const sslDomains = domainServices.filter((s) => s.ssl === true).map((s) => s.domain);

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

  // The HTTP-only nginx config used ONLY for first-time bootstrap (before Certbot). It is
  // written with the TARGET color's ports; the executor resolves color at run time.
  const bootstrapNginx = (color) => {
    const backend = services.find((s) => (s.role ?? s.name) === "backend" || s.name === "backend");
    const backendPort = backend ? (color === "blue" ? backend.hostPortBlue : backend.hostPortGreen) : undefined;
    const blocks = domainServices.map((s) => ({
      service: s.name,
      role: s.role,
      domain: s.domain,
      port: color === "blue" ? s.hostPortBlue : s.hostPortGreen,
      backendPort: (s.role ?? s.name) === "admin" ? backendPort : undefined,
    }));
    return renderProjectNginx({ project, uploadsPath, blocks });
  };

  // Port-var switch spec: which `set $<svc>_port N;` values to sed for the TARGET color.
  const portVarsFor = (color) =>
    services.map((s) => ({ var: `${s.name}_port`, blue: s.hostPortBlue, green: s.hostPortGreen, color }));

  const steps = [
    { type: "determine_active", markerPath, note: "read active_env -> TARGET=idle, OLD=current" },
    {
      type: "ensure_dirs",
      dirs: [`${projectRoot}/blue`, `${projectRoot}/green`, sharedDir, uploadsPath, `${projectRoot}/db`],
      note: "ensure project directory layout",
    },
    { type: "ensure_network", network, note: "ensure external docker network" },
  ];

  if (db.enabled) {
    steps.push(
      { type: "write_file", path: `${projectRoot}/db/docker-compose.db.yml`, content: renderDbCompose({ project, network, db }), note: "write DB compose" },
      { type: "compose_up", file: `${projectRoot}/db/docker-compose.db.yml`, envFile: `${projectRoot}/db/.env`, projectName: `${project}-db`, note: "start DB (idempotent)" },
    );
  }

  for (const s of services.filter((x) => x.envFromSecret)) {
    steps.push({ type: "write_env", path: `${sharedDir}/${s.name}.env`, secretName: s.envFromSecret, note: `write shared env for ${s.name}` });
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
    { type: "compose_pull_target", projectRoot, project, note: "compose -p <project>-<TARGET> pull" },
    { type: "compose_up_target", projectRoot, project, note: "compose -p <project>-<TARGET> up -d --force-recreate" },
  );

  if (migrate?.command) {
    steps.push({ type: "migrate", service: migrate.service ?? "backend", command: migrate.command, project, note: "run migrations in TARGET backend" });
  }

  steps.push({
    type: "health_check_target",
    project,
    services: domainServices.map((s) => ({ name: s.name, blue: s.hostPortBlue, green: s.hostPortGreen, path: healthPathFor(s) })),
    note: "health-check TARGET services (curl -fs, 20 retries)",
  });

  // First-time bootstrap: only if the nginx conf does not yet exist. Writes HTTP config
  // pointing at the TARGET color, enables it, reloads, then runs certbot for SSL.
  steps.push({
    type: "bootstrap_nginx_if_missing",
    availPath,
    enabledPath,
    blueContent: bootstrapNginx("blue"),
    greenContent: bootstrapNginx("green"),
    sslDomains,
    note: "first deploy only: write HTTP conf + enable + certbot (preserves SSL on later deploys)",
  });

  // Normal switch: sed the port vars in the EXISTING conf (keeps Certbot's SSL lines).
  steps.push(
    { type: "switch_ports", availPath, portVars: portVarsFor("target"), note: "sed set $<svc>_port to TARGET ports in existing conf" },
    { type: "nginx_reload", note: "nginx -t && reload" },
    { type: "write_active_marker", markerPath, note: "echo TARGET > active_env" },
    {
      type: "verify_live",
      checks: domainServices.map((s) => ({ domain: s.domain, ssl: s.ssl === true, path: healthPathFor(s) })),
      note: "verify each domain live (https if ssl else http via host header)",
    },
    { type: "compose_down_old", projectRoot, project, note: "compose -p <project>-<OLD> down" },
  );

  return {
    driver: "docker-vps",
    mode: "compose-blue-green",
    identity: { project, environment, projectRoot, network, availPath, enabledPath, markerPath },
    steps,
  };
}

/**
 * Rollback: switch traffic back to the OLD color by sed-ing the port vars, reload,
 * verify, and update the marker. We bring the previous color back UP first (it may have
 * been taken down by the last deploy's compose_down_old).
 */
export function planRollback({ project, environment, services, basePath = "/opt" }) {
  if (!project || !environment) throw new Error("project/environment required");
  if (!Array.isArray(services) || services.length === 0) throw new Error("services required");

  const projectRoot = `${basePath}/${project}`.replace(/\/+/g, "/");
  const availPath = `${NGINX_SITES_AVAILABLE}/${project}`;
  const markerPath = `${projectRoot}/active_env`;
  const domainServices = services.filter((s) => s.domain);

  const portVars = services.map((s) => ({ var: `${s.name}_port`, blue: s.hostPortBlue, green: s.hostPortGreen, color: "old" }));

  return {
    driver: "docker-vps",
    mode: "compose-blue-green",
    identity: { project, environment, projectRoot, availPath, markerPath },
    steps: [
      { type: "determine_active", markerPath, note: "current=LIVE(bad); OLD=the other" },
      { type: "compose_up_old", projectRoot, project, note: "ensure previous color is up (compose -p <project>-<OLD> up -d)" },
      { type: "switch_ports", availPath, portVars, note: "sed set $<svc>_port back to OLD ports" },
      { type: "nginx_reload", note: "atomic switch back" },
      { type: "write_active_marker_old", markerPath, note: "echo OLD > active_env" },
      { type: "verify_live", checks: domainServices.map((s) => ({ domain: s.domain, ssl: s.ssl === true, path: (s.role ?? s.name) === "backend" ? "/api/health" : "/" })), note: "confirm restored" },
    ],
  };
}
