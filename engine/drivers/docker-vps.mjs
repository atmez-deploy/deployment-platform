// VPS Docker blue/green publisher. PURE: emits a deterministic step plan.
// The executor compiles steps into ssh/docker commands; a runner executes them.
// See docs/docker-vps-design.md.

import {
  containerName,
  networkName,
  nginxConfName,
  activeMarkerPath,
  otherColor,
} from "../naming.mjs";
import { renderSiteConfig } from "../nginx.mjs";

const NGINX_SITES = "/etc/nginx/sites-enabled";

function assertImageRef(ref) {
  // Require an immutable-ish ref: registry/name@sha256:... or registry/name:tag
  if (!/^[\w./-]+(:[\w.-]+|@sha256:[a-f0-9]{64})$/.test(String(ref ?? ""))) {
    throw new Error(`invalid image reference: ${ref}`);
  }
  return ref;
}

/**
 * Build a blue/green deploy plan for one service.
 * @param {Object} args
 * @param {string} args.project
 * @param {string} args.environment
 * @param {string} args.service
 * @param {string} args.image            immutable image ref (…@sha256 or :tag)
 * @param {number} args.port             allocated host port to bind the live color to
 * @param {string} args.domain           public domain for nginx
 * @param {boolean|"managed_by_provider"} [args.ssl]
 * @param {Object} [args.health]         { path, expect_status, timeout_seconds, retries }
 * @param {Object} [args.migrate]        { command } run inside the new container before switch
 * @param {string} [args.basePath]       deployments root (default /opt/deployments)
 * @param {string} [args.activeColor]    known current color, if the caller has it; else "detect"
 * @returns {{driver, mode, identity, steps}}
 */
export function planDeploy({
  project,
  environment,
  service,
  image,
  port,
  domain,
  ssl = false,
  health = {},
  migrate = null,
  basePath = "/opt/deployments",
  activeColor = "detect",
}) {
  assertImageRef(image);
  if (!project || !environment || !service) throw new Error("project/environment/service required");
  if (!Number.isInteger(port)) throw new Error("port must be an integer");
  if (!domain) throw new Error("domain is required");

  const network = networkName(project, environment);
  const confName = nginxConfName(project, environment, service);
  const confPath = `${NGINX_SITES}/${confName}`;
  const upstreamName = `${project}-${environment}-${service}`;
  const markerPath = activeMarkerPath(basePath, project, environment, service);

  // If the caller knows the active color we target the other; otherwise the executor
  // resolves it at run time (determine_active) and the target color is "the idle one".
  const targetColor = activeColor === "detect" ? "detect" : otherColor(activeColor);

  const steps = [
    { type: "determine_active", markerPath, note: "read current live color (default blue if none)" },
    { type: "ensure_network", network, note: "create the project network if missing" },
    { type: "pull", image, note: "pull the immutable image" },
    {
      type: "run_container",
      container: "<idle>", // executor fills color once known
      containerBlue: containerName(project, environment, service, "blue"),
      containerGreen: containerName(project, environment, service, "green"),
      image,
      network,
      port,
      note: "start the new version on the idle color, bound to the allocated port",
    },
  ];

  if (migrate?.command) {
    steps.push({ type: "migrate", command: migrate.command, note: "run migrations in the new container" });
  }

  steps.push(
    {
      type: "health_check",
      path: health.path ?? "/health",
      expectStatus: health.expect_status ?? 200,
      timeoutSeconds: health.timeout_seconds ?? 30,
      retries: health.retries ?? 5,
      port,
      note: "probe the new container until healthy (no traffic yet)",
    },
    {
      type: "nginx_write",
      confPath,
      // The executor renders with the idle color's port; we precompute the text for the
      // simple single-port MVP where the live color binds `port`.
      content: renderSiteConfig({ domain, port, upstreamName, ssl }),
      note: "write nginx upstream pointing at the new color",
    },
    { type: "nginx_reload", note: "nginx -t && reload — atomic traffic switch" },
    {
      type: "verify_live",
      domain,
      expectStatus: health.expect_status ?? 200,
      note: "confirm the public URL serves the new version",
    },
    { type: "write_active_marker", markerPath, note: "record the new live color" },
    {
      type: "stop_old",
      note: "stop + remove the previously-active container",
    },
  );

  return {
    driver: "docker-vps",
    mode: "blue-green",
    identity: { project, environment, service, network, confPath, upstreamName, markerPath, targetColor },
    steps,
  };
}

/**
 * Build a rollback plan: switch nginx back to the previous color.
 * @param {Object} args  same identity fields as planDeploy (project/environment/service/port/domain)
 */
export function planRollback({
  project,
  environment,
  service,
  port,
  domain,
  ssl = false,
  basePath = "/opt/deployments",
}) {
  if (!project || !environment || !service) throw new Error("project/environment/service required");
  if (!Number.isInteger(port)) throw new Error("port must be an integer");
  if (!domain) throw new Error("domain is required");

  const confName = nginxConfName(project, environment, service);
  const confPath = `${NGINX_SITES}/${confName}`;
  const upstreamName = `${project}-${environment}-${service}`;
  const markerPath = activeMarkerPath(basePath, project, environment, service);

  return {
    driver: "docker-vps",
    mode: "blue-green",
    identity: { project, environment, service, confPath, upstreamName, markerPath },
    steps: [
      { type: "determine_active", markerPath, note: "find the current (bad) color" },
      { type: "assert_other_exists", note: "ensure the previous color's container is still running" },
      {
        type: "nginx_write",
        confPath,
        content: renderSiteConfig({ domain, port, upstreamName, ssl }),
        note: "point upstream back at the previous color",
      },
      { type: "nginx_reload", note: "atomic switch back" },
      { type: "verify_live", domain, expectStatus: 200, note: "confirm restored" },
      { type: "write_active_marker", markerPath, note: "record the restored color" },
    ],
  };
}
