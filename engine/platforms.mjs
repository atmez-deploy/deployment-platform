// Platform capability registry (Level 1).
//
// Declares, per selectable platform: which driver/command it maps to, the inputs it
// needs (config vs secret), the one-time MANUAL prerequisites a human must do, and
// whether the platform supports fully-automated deploys. A preflight() validates that
// the required inputs are present for a chosen platform and returns the checklist.
//
// This is the data behind "pick a platform -> see the right fields/checklist -> dry run
// -> deploy". In GitHub Actions it drives a flat workflow_dispatch; a future dashboard
// (Option B) can render dynamic forms from the same definitions.

/**
 * inputs[]: { name, from: "config"|"secret", required, note }
 * checklist[]: strings — manual steps the operator must complete first.
 * supportsFullDeploy: whether onboarding/provisioning can be fully automated.
 */
export const PLATFORMS = {
  vps: {
    label: "Own VPS (Docker blue/green)",
    kind: "vps",
    command: "deploy-service",
    supportsFullDeploy: true,
    inputs: [
      { name: "config", from: "config", required: true, note: "project config path" },
      { name: "registry", from: "config", required: true, note: "resource registry path" },
      { name: "environment", from: "config", required: true, note: "environment name" },
      { name: "image", from: "config", required: true, note: "immutable image ref(s), name=ref" },
      { name: "DEPLOY_SSH_KEY", from: "secret", required: true, note: "SSH private key for the deploy user" },
    ],
    checklist: [
      "VPS reachable over SSH with a deploy user (docker + nginx reload permitted).",
      "Docker and Nginx installed; /etc/nginx/sites-enabled included in nginx.conf.",
      "Project+environment registered in the registry (port block + domains allocated).",
      "Image built and pushed to the registry by the app repo's own CI.",
    ],
  },

  "hostinger-ssh": {
    label: "Hostinger (static, SSH releases + symlink rollback)",
    kind: "hostinger",
    command: "deploy",
    supportsFullDeploy: false, // FTP account/subdomain are manual (no shared-hosting API)
    inputs: [
      { name: "config", from: "config", required: true, note: "project config path" },
      { name: "environment", from: "config", required: true, note: "environment name" },
      { name: "DEPLOY_SSH_KEY", from: "secret", required: true, note: "SSH private key for the account" },
    ],
    checklist: [
      "Hostinger plan has SSH access enabled (hPanel -> Advanced -> SSH Access).",
      "Public key added to the account; private key stored as the DEPLOY_SSH_KEY secret.",
      "Subdomain/domain created and pointed to the account (manual in hPanel).",
      "SSL is managed by Hostinger (hPanel), not by the platform.",
    ],
  },

  "hostinger-ftp": {
    label: "Hostinger (static, FTPS mirror — no atomic rollback)",
    kind: "hostinger",
    command: "deploy",
    supportsFullDeploy: false,
    inputs: [
      { name: "config", from: "config", required: true, note: "project config path (auth: ftps)" },
      { name: "environment", from: "config", required: true, note: "environment name" },
      { name: "FTP_PASSWORD", from: "secret", required: true, note: "FTP password" },
      { name: "FTP_HOST", from: "secret", required: false, note: "override host (else from config)" },
      { name: "FTP_USERNAME", from: "secret", required: false, note: "override username (else from config)" },
    ],
    checklist: [
      "FTP account created in hPanel; password stored as the FTP_PASSWORD secret.",
      "Subdomain/domain created and pointed to the account (manual in hPanel).",
      "Note: FTPS deploys are not atomic; rollback = redeploy the previous build.",
      "SSL is managed by Hostinger (hPanel).",
    ],
  },
};

export function listPlatforms() {
  return Object.entries(PLATFORMS).map(([id, p]) => ({ id, label: p.label, supportsFullDeploy: p.supportsFullDeploy }));
}

export class PlatformError extends Error {
  constructor(message) {
    super(message);
    this.name = "PlatformError";
  }
}

/**
 * Validate that the required inputs for a platform are present.
 * @param {string} platformId
 * @param {object} provided  map of field name -> truthy if provided (config keys + env names)
 * @returns {{platform, checklist:string[], missing:string[], ok:boolean}}
 * @throws {PlatformError} if the platform id is unknown
 */
export function preflight(platformId, provided = {}) {
  const platform = PLATFORMS[platformId];
  if (!platform) {
    throw new PlatformError(`unknown platform '${platformId}'. Known: ${Object.keys(PLATFORMS).join(", ")}`);
  }
  const missing = platform.inputs
    .filter((i) => i.required && !provided[i.name])
    .map((i) => i.name);
  return {
    platform: platformId,
    driver: platform.kind,
    command: platform.command,
    supportsFullDeploy: platform.supportsFullDeploy,
    checklist: platform.checklist,
    missing,
    ok: missing.length === 0,
  };
}
