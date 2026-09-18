// Static publisher for the "hostinger" driver.
//
// Design: this module is PURE. It does not connect, upload, or run anything.
// It produces a deterministic PLAN — an ordered list of typed steps — that a thin
// executor (engine/executor) turns into real ssh/rsync/lftp commands. This keeps the
// hard logic unit-testable and secret-free (Rules 11, 14).
//
// Shared-hosting reality: Hostinger serves files DIRECTLY from <webroot> (public_html),
// not from a `current` symlink, and you can't change the document root on shared plans.
// So both SSH and FTP here MIRROR the build straight into <webroot> — exactly what you do
// by hand (paste the contents of dist/out into public_html). This is not atomic, so
// rollback = redeploy the previous build. (The atomic releases+symlink model belongs to
// our own VPS/nginx driver, where we control the document root.)
//   SSH  -> rsync -az --delete <localDir>/  <webroot>/
//   FTPS -> lftp mirror <localDir> <webroot>

/**
 * @typedef {Object} HostingerConnection
 * @property {string} host
 * @property {number} [port]
 * @property {string} username
 * @property {string} webroot          e.g. "public_html"
 * @property {"ssh_key"|"ftps"} auth
 * @property {"rsync"|"scp"|"ftps"} [transfer]
 */

const RELEASES_DIR = "releases";
const CURRENT_LINK = "current";

function assertSha(sha) {
  if (!/^[a-zA-Z0-9._-]+$/.test(String(sha ?? ""))) {
    throw new Error(`invalid release id (sha): ${sha}`);
  }
  return sha;
}

/** Join POSIX path segments (targets are Linux). */
function posixJoin(...parts) {
  return parts.join("/").replace(/\/+/g, "/");
}

/**
 * Build the deploy plan.
 * @param {Object} args
 * @param {HostingerConnection} args.connection
 * @param {string} args.sha            immutable release id (commit sha)
 * @param {string} args.localDir       local built-site dir to upload (e.g. "dist")
 * @param {number} [args.keepReleases] how many old releases to retain (default 5)
 * @returns {{driver:string, mode:string, steps: object[]}}
 */
export function planDeploy({ connection, sha, localDir }) {
  if (sha !== undefined) assertSha(sha); // sha is optional now (kept for interface compat)
  if (!localDir) throw new Error("localDir is required");
  if (!connection?.webroot) throw new Error("connection.webroot is required");

  const webroot = connection.webroot;

  if (connection.auth === "ssh_key") {
    // Mirror straight into the webroot over rsync/scp — what actually shows in the browser
    // on shared hosting. --delete keeps the webroot exactly matching the build output.
    return {
      driver: "hostinger",
      mode: "ssh-mirror",
      steps: [
        { type: "ensure_dir", path: webroot, note: "ensure webroot exists" },
        {
          type: "upload",
          method: connection.transfer === "scp" ? "scp" : "rsync",
          localDir,
          remoteDir: webroot,
          mirror: true,
          note: "mirror built site directly into webroot (served as-is on shared hosting)",
        },
        {
          type: "verify",
          check: "path_exists",
          path: posixJoin(webroot, "index.html"),
          note: "sanity check index.html landed in the webroot",
        },
      ],
    };
  }

  return planDeployFtps({ connection, localDir });
}

/** FTPS: mirror the build directly into webroot (non-atomic). */
function planDeployFtps({ connection, localDir }) {
  return {
    driver: "hostinger",
    mode: "ftps-mirror",
    steps: [
      {
        type: "upload",
        method: "ftps",
        localDir,
        remoteDir: connection.webroot,
        mirror: true,
        note: "mirror built site into webroot (no atomic swap on FTPS)",
      },
    ],
  };
}

/**
 * Build the rollback plan: repoint `current` to a known previous release.
 * SSH only — FTPS rollback requires re-running a deploy of the prior build.
 * @param {Object} args
 * @param {HostingerConnection} args.connection
 * @param {string} args.toSha  the release id to roll back to
 * @returns {{driver:string, mode:string, steps: object[]}}
 */
export function planRollback() {
  // Shared Hostinger serves the webroot directly (no symlink to flip), so rollback is not
  // an in-place switch — you redeploy the previous build. This is intentional and honest:
  // atomic rollback lives in the VPS/nginx driver where we control the document root.
  throw new Error(
    "rollback on shared Hostinger = redeploy the previous build (no atomic switch on shared hosting). " +
      "Re-run deploy with the prior build output.",
  );
}
