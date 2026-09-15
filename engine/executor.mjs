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
 * Turn a plan into an ordered list of concrete commands. Dispatches by plan.driver.
 * @param {object} plan  a driver plan (static-hostinger or docker-vps)
 * @param {object} conn  connection (host, port, username, ...)
 * @param {object} [opts] { keyPath, localDir } — keyPath is the ssh identity file path
 * @returns {{label:string, bin:string, args:string[]}[]}
 */
export function toCommands(plan, conn, opts = {}) {
  if (plan.driver === "docker-vps") return dockerVpsToCommands(plan, conn, opts);
  return staticToCommands(plan, conn, opts);
}

/** Compile static-hostinger plans to ssh/rsync/lftp commands. */
function staticToCommands(plan, conn, opts = {}) {
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

/**
 * Compile docker-vps blue/green plans to ssh + docker commands.
 * The active color is resolved on the VPS at run time via a marker file; for the
 * dry run / command view we express that as a shell expression the remote evaluates.
 */
function dockerVpsToCommands(plan, conn, opts = {}) {
  const { keyPath } = opts;
  const commands = [];
  const id = plan.identity;

  // Remote shell snippet that echoes the CURRENT live color (default blue), and the IDLE
  // color = the other one. We compute both into shell vars the remote reuses per command.
  const readColors =
    `CUR=$(cat ${shq(id.markerPath)} 2>/dev/null || echo blue); ` +
    `if [ "$CUR" = blue ]; then IDLE=green; else IDLE=blue; fi`;

  const containerFor = (colorVar) =>
    // e.g. example-app-staging-backend-$IDLE
    `${id.project}-${id.environment}-${id.service}-$${colorVar}`;

  for (const step of plan.steps) {
    const s = sshBase(conn, keyPath);
    switch (step.type) {
      case "determine_active":
        commands.push({
          label: "determine_active (read live color marker)",
          bin: s.bin,
          args: [...s.args, s.dest, `${readColors}; echo "live=$CUR idle=$IDLE"`],
        });
        break;
      case "ensure_network":
        commands.push({
          label: `ensure_network ${step.network}`,
          bin: s.bin,
          args: [...s.args, s.dest, `docker network inspect ${shq(step.network)} >/dev/null 2>&1 || docker network create ${shq(step.network)}`],
        });
        break;
      case "pull":
        commands.push({
          label: `pull ${step.image}`,
          bin: s.bin,
          args: [...s.args, s.dest, `docker pull ${shq(step.image)}`],
        });
        break;
      case "run_container": {
        const name = containerFor("IDLE");
        const run =
          `${readColors}; ` +
          `docker rm -f ${name} >/dev/null 2>&1 || true; ` +
          `docker run -d --name ${name} --network ${shq(step.network)} ` +
          `-p 127.0.0.1:${step.port}:${step.port} --restart unless-stopped ${shq(step.image)}`;
        commands.push({ label: "run_container (idle color)", bin: s.bin, args: [...s.args, s.dest, run] });
        break;
      }
      case "migrate": {
        const name = containerFor("IDLE");
        const cmd = `${readColors}; docker exec ${name} sh -lc ${shq(step.command)}`;
        commands.push({ label: "migrate (in new container)", bin: s.bin, args: [...s.args, s.dest, cmd] });
        break;
      }
      case "health_check": {
        const probe =
          `for i in $(seq 1 ${step.retries + 1}); do ` +
          `code=$(curl -s -o /dev/null -w '%{http_code}' --max-time ${step.timeoutSeconds} ` +
          `http://127.0.0.1:${step.port}${step.path} || true); ` +
          `if [ "$code" = "${step.expectStatus}" ]; then echo healthy; exit 0; fi; sleep 2; done; ` +
          `echo unhealthy; exit 1`;
        commands.push({ label: `health_check ${step.path}`, bin: s.bin, args: [...s.args, s.dest, probe] });
        break;
      }
      case "nginx_write": {
        // write the rendered config via a heredoc, guarding the marker on the content
        const write = `cat > ${shq(step.confPath)} <<'ATMEZEOF'\n${step.content}ATMEZEOF`;
        commands.push({ label: `nginx_write ${step.confPath}`, bin: s.bin, args: [...s.args, s.dest, write] });
        break;
      }
      case "nginx_reload":
        commands.push({
          label: "nginx_reload (test + reload)",
          bin: s.bin,
          args: [...s.args, s.dest, `nginx -t && (systemctl reload nginx || nginx -s reload)`],
        });
        break;
      case "verify_live":
        commands.push({
          label: `verify_live ${step.domain}`,
          bin: s.bin,
          args: [
            ...s.args,
            s.dest,
            `code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: ${step.domain}' http://127.0.0.1/ || true); ` +
              `[ "$code" = "${step.expectStatus}" ] || (echo "got $code"; exit 1)`,
          ],
        });
        break;
      case "write_active_marker": {
        // after a successful switch, the live color becomes the previously-idle one
        const cmd = `${readColors}; mkdir -p "$(dirname ${shq(step.markerPath)})"; echo "$IDLE" > ${shq(step.markerPath)}`;
        commands.push({ label: "write_active_marker", bin: s.bin, args: [...s.args, s.dest, cmd] });
        break;
      }
      case "assert_other_exists": {
        const other = containerFor("IDLE");
        commands.push({
          label: "assert_other_exists (previous color container running)",
          bin: s.bin,
          args: [...s.args, s.dest, `${readColors}; docker ps --format '{{.Names}}' | grep -qx ${other} || (echo "previous container missing"; exit 1)`],
        });
        break;
      }
      case "stop_old": {
        // Runs AFTER write_active_marker, so the marker already holds the NEW live color.
        // The container to stop is therefore the OTHER color relative to the marker.
        const old = `${id.project}-${id.environment}-${id.service}-$OLD`;
        const cmd =
          `LIVE=$(cat ${shq(id.markerPath)} 2>/dev/null || echo blue); ` +
          `if [ "$LIVE" = blue ]; then OLD=green; else OLD=blue; fi; ` +
          `docker stop ${old} >/dev/null 2>&1 || true; docker rm ${old} >/dev/null 2>&1 || true`;
        commands.push({ label: "stop_old (previous color)", bin: s.bin, args: [...s.args, s.dest, cmd] });
        break;
      }
      default:
        throw new Error(`unknown docker-vps step type: ${step.type}`);
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
