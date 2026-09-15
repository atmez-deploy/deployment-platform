// Deterministic resource naming derived from project+environment+service identity.
// Every name the docker-vps driver produces goes through here (Rule 5), so isolation
// between projects on a shared VPS is guaranteed by construction (Rule 2).

const COLORS = ["blue", "green"];

export function otherColor(color) {
  if (!COLORS.includes(color)) throw new Error(`invalid color: ${color}`);
  return color === "blue" ? "green" : "blue";
}

export function containerName(project, env, service, color) {
  return `${project}-${env}-${service}-${color}`;
}

export function networkName(project, env) {
  return `${project}-${env}-network`;
}

export function nginxConfName(project, env, service) {
  return `${project}-${env}-${service}.conf`;
}

/** Path where the active-color marker is stored on the VPS. */
export function activeMarkerPath(basePath, project, env, service) {
  return `${basePath}/${project}/${env}/state/active_color_${service}`.replace(/\/+/g, "/");
}

export { COLORS };
