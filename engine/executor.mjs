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
          // ftps: delegate to lftp mirror (executor requires FTP_PASSWORD in env at run time)
          commands.push({
            label: `upload(ftps mirror) -> ${step.remoteDir}`,
            bin: "lftp",
            args: [
              "-c",
              `set ftp:ssl-force true; open -u ${conn.username},$FTP_PASSWORD ${conn.host}; ` +
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
 * Compile compose-based docker-vps blue/green plans to ssh + docker compose + nginx +
 * certbot commands. The active color is resolved on the VPS at run time via the marker
 * file; the IDLE color receives the new deploy. Both colors stay running.
 */
function dockerVpsToCommands(plan, conn, opts = {}) {
  const { keyPath } = opts;
  const commands = [];
  const id = plan.identity;
  const push = (label, remote) => {
    const s = sshBase(conn, keyPath);
    commands.push({ label, bin: s.bin, args: [...s.args, s.dest, remote] });
  };

  // CUR = live color (default blue); IDLE = the other. Recomputed per remote command.
  const readColors =
    `CUR=$(cat ${shq(id.markerPath)} 2>/dev/null || echo blue); ` +
    `if [ "$CUR" = blue ]; then IDLE=green; else IDLE=blue; fi`;

  // heredoc file write helper (content may contain quotes; the quoted delimiter is safe)
  const writeFile = (path, content) => `mkdir -p "$(dirname ${shq(path)})"; cat > ${shq(path)} <<'ATMEZEOF'\n${content}ATMEZEOF`;

  for (const step of plan.steps) {
    switch (step.type) {
      case "determine_active":
        push("determine_active (read live color)", `${readColors}; echo "live=$CUR idle=$IDLE"`);
        break;
      case "ensure_dirs":
        push("ensure_dirs", `mkdir -p ${step.dirs.map(shq).join(" ")}`);
        break;
      case "ensure_network":
        push(`ensure_network ${step.network}`, `docker network inspect ${shq(step.network)} >/dev/null 2>&1 || docker network create ${shq(step.network)}`);
        break;
      case "write_file":
        push(`write_file ${step.path}`, writeFile(step.path, step.content));
        break;
      case "write_env":
        // secret contents come from an env var at run time; never embedded in the plan
        push(`write_env ${step.path} (from $${step.secretName})`, `mkdir -p "$(dirname ${shq(step.path)})"; printf '%s' "$${step.secretName}" > ${shq(step.path)}; chmod 600 ${shq(step.path)}`);
        break;
      case "write_compose":
        push("write_compose (blue)", writeFile(step.blueFile, step.blueContent));
        push("write_compose (green)", writeFile(step.greenFile, step.greenContent));
        break;
      case "compose_up": {
        const env = step.envFile ? `--env-file ${shq(step.envFile)} ` : "";
        push(`compose_up ${step.file}`, `docker compose ${env}-f ${shq(step.file)} up -d`);
        break;
      }
      case "compose_pull_idle":
        push("compose_pull_idle", `${readColors}; docker compose -f ${shq(step.projectRoot)}/$IDLE/docker-compose.app.yml pull`);
        break;
      case "compose_up_idle":
        push("compose_up_idle", `${readColors}; docker compose -f ${shq(step.projectRoot)}/$IDLE/docker-compose.app.yml up -d`);
        break;
      case "migrate":
        push(`migrate (${step.service})`, `${readColors}; docker exec ${id.project}-$IDLE-${step.service}-1 sh -lc ${shq(step.command)}`);
        break;
      case "health_check_idle": {
        // probe each domain-exposed service on the IDLE color's port
        const probes = step.services
          .map(
            (svc) =>
              `P=$([ "$IDLE" = blue ] && echo ${svc.blue} || echo ${svc.green}); ` +
              `ok=0; for i in $(seq 1 6); do code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:$P${svc.path} || true); ` +
              `if [ "$code" = 200 ] || [ "$code" = 301 ] || [ "$code" = 302 ]; then ok=1; break; fi; sleep 2; done; ` +
              `[ "$ok" = 1 ] || (echo "unhealthy ${svc.name} on :$P"; exit 1)`,
          )
          .join("; ");
        push("health_check_idle (probe idle color ports)", `${readColors}; ${probes}`);
        break;
      }
      case "nginx_write": {
        // choose the IDLE color's rendered config, write to sites-available, symlink enabled
        const write =
          `${readColors}; ` +
          `if [ "$IDLE" = blue ]; then cat > ${shq(step.availPath)} <<'ATMEZEOF'\n${step.blueContent}ATMEZEOF\n` +
          `else cat > ${shq(step.availPath)} <<'ATMEZEOF'\n${step.greenContent}ATMEZEOF\n fi; ` +
          `ln -sfn ${shq(step.availPath)} ${shq(step.enabledPath)}`;
        push(`nginx_write ${step.availPath}`, write);
        break;
      }
      case "nginx_reload":
        push("nginx_reload (test + reload)", `nginx -t && (systemctl reload nginx || nginx -s reload)`);
        break;
      case "certbot": {
        const domainArgs = step.domains.map((d) => `-d ${shq(d)}`).join(" ");
        // idempotent: --keep-until-expiring won't re-issue if a valid cert exists
        push(`certbot ${step.domains.join(",")}`, `certbot --nginx --non-interactive --agree-tos --keep-until-expiring ${domainArgs} || echo "certbot skipped/failed (continuing)"`);
        break;
      }
      case "verify_live": {
        const checks = step.checks
          .map((c) => {
            const scheme = c.ssl ? "https" : "http";
            return `code=$(curl -sk -o /dev/null -w '%{http_code}' ${scheme}://${c.domain}${c.path} || true); ` +
              `case "$code" in 200|301|302) : ;; *) echo "verify failed ${c.domain} ($code)"; exit 1;; esac`;
          })
          .join("; ");
        push("verify_live (per domain)", checks);
        break;
      }
      case "assert_other_up":
        push("assert_other_up (previous color running)", `${readColors}; docker ps --format '{{.Names}}' | grep -q "${id.project}-$CUR-" || (echo "previous color not running"; exit 1)`);
        break;
      case "write_active_marker":
        // after a successful switch, live color becomes the previously-idle one
        push("write_active_marker", `${readColors}; mkdir -p "$(dirname ${shq(step.markerPath)})"; echo "$IDLE" > ${shq(step.markerPath)}`);
        break;
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
