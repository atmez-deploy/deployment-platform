// Plan executor for the static publisher.
//
// Two halves:
//   1) toCommands(plan, conn)  — PURE. Turns a plan into concrete shell commands
//      (ssh/rsync). Fully unit-testable and safe to print in a dry run.
//   2) runPlan(plan, conn, opts) — the only impure part: spawns the commands.
//      Guarded by opts.execute so tests/dry-runs never touch the network.
//
// Secrets are never embedded. SSH auth uses a key FILE path the caller has already
// written from the SecretProvider (Rule 3/11). We pass -i <keyPath> and standard
// non-interactive ssh options.

import { spawnSync } from "node:child_process";

/** Shell-quote a single argument for POSIX remote commands. */
function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function sshBase(conn, keyPath) {
  const args = [
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-p", String(conn.port ?? 22),
  ];
  if (keyPath) args.unshift("-i", keyPath);
  return { bin: "ssh", args, dest: `${conn.username}@${conn.host}` };
}

/**
 * Turn a plan into an ordered list of concrete commands.
 * @param {object} plan  from static-hostinger planDeploy/planRollback
 * @param {object} conn  connection (host, port, username, webroot, auth, transfer)
 * @param {object} [opts] { keyPath, localDir } — keyPath is the ssh identity file path
 * @returns {{label:string, bin:string, args:string[]}[]}
 */
export function toCommands(plan, conn, opts = {}) {
  const { keyPath } = opts;
  const commands = [];

  for (const step of plan.steps) {
    switch (step.type) {
      case "ensure_dir": {
        const s = sshBase(conn, keyPath);
        commands.push({
          label: `ensure_dir ${step.path}`,
          bin: s.bin,
          args: [...s.args, s.dest, `mkdir -p ${shq(step.path)}`],
        });
        break;
      }
      case "upload": {
        if (step.method === "rsync") {
          const sshCmd = [
            "ssh",
            keyPath ? `-i ${keyPath}` : "",
            "-o BatchMode=yes",
            "-o StrictHostKeyChecking=accept-new",
            `-p ${conn.port ?? 22}`,
          ]
            .filter(Boolean)
            .join(" ");
          // trailing slash on source => copy contents, not the dir itself
          const src = step.localDir.endsWith("/") ? step.localDir : `${step.localDir}/`;
          commands.push({
            label: `upload(rsync) -> ${step.remoteDir}`,
            bin: "rsync",
            args: [
              "-az",
              "--delete",
              "-e", sshCmd,
              src,
              `${conn.username}@${conn.host}:${step.remoteDir}/`,
            ],
          });
        } else if (step.method === "scp") {
          const s = sshBase(conn, keyPath);
          commands.push({
            label: `upload(scp) -> ${step.remoteDir}`,
            bin: "scp",
            args: [...s.args, "-r", `${step.localDir}/.`, `${s.dest}:${step.remoteDir}/`],
          });
        } else {
          // ftps: delegate to lftp mirror (executor requires FTPS_PASSWORD in env at run time)
          commands.push({
            label: `upload(ftps mirror) -> ${step.remoteDir}`,
            bin: "lftp",
            args: [
              "-c",
              `set ftp:ssl-force true; open -u ${conn.username},$FTPS_PASSWORD ${conn.host}; ` +
                `mirror -R --delete ${step.localDir} ${step.remoteDir}`,
            ],
          });
        }
        break;
      }
      case "symlink_swap": {
        const s = sshBase(conn, keyPath);
        // atomic swap: create temp symlink then mv over the target
        const cmd =
          `ln -sfn ${shq(step.target)} ${shq(step.link + ".tmp")} && ` +
          `mv -T ${shq(step.link + ".tmp")} ${shq(step.link)}`;
        commands.push({
          label: `symlink_swap ${step.link} -> ${step.target}`,
          bin: s.bin,
          args: [...s.args, s.dest, cmd],
        });
        break;
      }
      case "verify": {
        const s = sshBase(conn, keyPath);
        commands.push({
          label: `verify path_exists ${step.path}`,
          bin: s.bin,
          args: [...s.args, s.dest, `test -e ${shq(step.path)}`],
        });
        break;
      }
      case "prune_releases": {
        const s = sshBase(conn, keyPath);
        // keep the newest N by mtime, delete the rest
        const cmd =
          `cd ${shq(step.releasesRoot)} && ` +
          `ls -1dt */ 2>/dev/null | tail -n +${step.keep + 1} | xargs -r rm -rf`;
        commands.push({
          label: `prune_releases keep=${step.keep}`,
          bin: s.bin,
          args: [...s.args, s.dest, cmd],
        });
        break;
      }
      default:
        throw new Error(`unknown step type: ${step.type}`);
    }
  }

  return commands;
}

/** Render commands as printable lines (dry run). Never includes secrets. */
export function renderCommands(commands) {
  return commands.map((c) => `${c.label}\n    $ ${c.bin} ${c.args.join(" ")}`).join("\n");
}

/**
 * Execute a plan. IMPURE. Only runs when opts.execute === true.
 * @returns {{ok:boolean, results: object[]}}
 */
export function runPlan(plan, conn, opts = {}) {
  const commands = toCommands(plan, conn, opts);
  if (!opts.execute) {
    return { ok: true, dryRun: true, commands };
  }
  const results = [];
  for (const c of commands) {
    const r = spawnSync(c.bin, c.args, { stdio: "inherit", env: process.env });
    results.push({ label: c.label, status: r.status });
    if (r.status !== 0) {
      return { ok: false, results, failedAt: c.label };
    }
  }
  return { ok: true, results };
}
