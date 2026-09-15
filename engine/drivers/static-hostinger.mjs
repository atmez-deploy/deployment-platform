// Static publisher for the "hostinger" driver.
//
// Design: this module is PURE. It does not connect, upload, or run anything.
// It produces a deterministic PLAN — an ordered list of typed steps — that a thin
// executor (engine/executor) turns into real ssh/rsync/lftp commands. This keeps the
// hard logic unit-testable and secret-free (Rules 11, 14).
//
// Release model over SSH (atomic, reversible — Rule 8):
//   <webroot>/
//     releases/<sha>/        <- fresh upload of the built site
//     current -> releases/<sha>   (symlink the web server serves)
// Deploy  = upload new release dir, then repoint `current`.
// Rollback = repoint `current` back to a previous release dir.
//
// FTPS fallback (cheapest shared hosting, no shell): no symlinks possible, so we
// mirror the build straight into <webroot>. Not atomic; rollback = re-upload prior build.

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
export function planDeploy({ connection, sha, localDir, keepReleases = 5 }) {
  assertSha(sha);
  if (!localDir) throw new Error("localDir is required");
  if (!connection?.webroot) throw new Error("connection.webroot is required");

  const useSsh = connection.auth === "ssh_key";
  if (!useSsh) return planDeployFtps({ connection, localDir });

  const webroot = connection.webroot;
  const releasesRoot = posixJoin(webroot, RELEASES_DIR);
  const releaseDir = posixJoin(releasesRoot, sha);
  const currentLink = posixJoin(webroot, CURRENT_LINK);

  return {
    driver: "hostinger",
    mode: "ssh-release",
    steps: [
      { type: "ensure_dir", path: releasesRoot, note: "make sure releases/ exists" },
      {
        type: "upload",
        method: connection.transfer ?? "rsync",
        localDir,
        remoteDir: releaseDir,
        note: "upload built site into a fresh release dir",
      },
      {
        type: "symlink_swap",
        link: currentLink,
        target: releaseDir,
        note: "atomically repoint current -> new release",
      },
      {
        type: "verify",
        check: "path_exists",
        path: posixJoin(currentLink, "index.html"),
        note: "sanity check the live path resolves",
      },
      {
        type: "prune_releases",
        releasesRoot,
        keep: keepReleases,
        note: "remove oldest releases beyond the retention window",
      },
    ],
  };
}

/** FTPS fallback: mirror the build directly into webroot (non-atomic). */
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
export function planRollback({ connection, toSha }) {
  assertSha(toSha);
  if (connection.auth !== "ssh_key") {
    throw new Error("rollback via symlink requires ssh_key auth; on FTPS, redeploy the prior build");
  }
  const webroot = connection.webroot;
  const releaseDir = posixJoin(webroot, RELEASES_DIR, toSha);
  const currentLink = posixJoin(webroot, CURRENT_LINK);
  return {
    driver: "hostinger",
    mode: "ssh-release",
    steps: [
      {
        type: "verify",
        check: "path_exists",
        path: releaseDir,
        note: "ensure the target release still exists before switching",
      },
      {
        type: "symlink_swap",
        link: currentLink,
        target: releaseDir,
        note: "repoint current -> previous release",
      },
    ],
  };
}
