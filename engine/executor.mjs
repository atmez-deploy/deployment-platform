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
  if (plan.driver === "cpanel") return cpanelToCommands(plan, conn, opts);
  return staticToCommands(plan, conn, opts);
}

/**
 * Compile cPanel plans to UAPI curl calls + an upload. cPanel UAPI is reached over HTTPS
 * on port 2083 with an "Authorization: cpanel <user>:<token>" header. The token comes from
 * the CPANEL_API_TOKEN env at run time (never embedded). These are LOCAL curl commands
 * (run from the runner), not ssh — cPanel has no shell requirement for UAPI.
 */
function cpanelToCommands(plan, conn, opts = {}) {
  const commands = [];
  const host = conn.host;
  const port = conn.port ?? 2083;
  const authHeader = `Authorization: cpanel ${conn.username}:$CPANEL_API_TOKEN`;

  for (const step of plan.steps) {
    switch (step.type) {
      case "uapi": {
        // build query params; the FTP password (if any) is read from env at call time
        const params = { ...step.params };
        const qs = Object.entries(params)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
          .join("&");
        const pwd = step.passwordFromEnv ? `&password=$${step.passwordFromEnv}` : "";
        const url = `https://${host}:${port}/execute/${step.module}/${step.func}?${qs}${pwd}`;
        // ignoreIfExists: cPanel returns an error string if it exists; we don't hard-fail.
        const tail = step.ignoreIfExists ? " || true" : "";
        commands.push({
          label: `uapi ${step.module}/${step.func}`,
          bin: "curl",
          args: ["-s", "-H", authHeader, url],
          _appendShell: tail,
        });
        break;
      }
      case "upload": {
        if (step.method === "ftps") {
          commands.push({
            label: `upload(ftps) -> ${step.docroot}`,
            bin: "lftp",
            args: [
              "-c",
              `set ftp:ssl-force true; open -u ${conn.username},$FTP_PASSWORD ${host}; ` +
                `mirror -R --delete ${step.localDir} ${step.docroot}`,
            ],
          });
        } else {
          // rsync over ssh into the docroot (cPanel hosts that allow SSH)
          const sshCmd = [
            "ssh",
            opts.keyPath ? `-i ${opts.keyPath}` : "",
            "-o BatchMode=yes",
            "-o StrictHostKeyChecking=accept-new",
            `-p ${conn.sshPort ?? 22}`,
          ]
            .filter(Boolean)
            .join(" ");
          const src = step.localDir.endsWith("/") ? step.localDir : `${step.localDir}/`;
          commands.push({
            label: `upload(rsync) -> ${step.docroot}`,
            bin: "rsync",
            args: ["-az", "--delete", "-e", sshCmd, src, `${conn.username}@${host}:${step.docroot}/`],
          });
        }
        break;
      }
      case "verify":
        commands.push({
          label: `verify ${step.url}`,
          bin: "curl",
          args: ["-fsk", step.url, "-o", "/dev/null"],
        });
        break;
      default:
        throw new Error(`unknown cpanel step type: ${step.type}`);
    }
  }
  return commands;
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

  // TARGET = idle color (receives the deploy); OLD = current live color. Mirrors
  // deploy-backend.sh: ACTIVE=$(cat active_env); if blue -> TARGET=green else blue.
  const readColors =
    `ACTIVE=$(cat ${shq(id.markerPath)} 2>/dev/null || echo blue); ` +
    `if [ "$ACTIVE" = blue ]; then TARGET=green; OLD=blue; else TARGET=blue; OLD=green; fi`;

  const writeFile = (path, content) => `mkdir -p "$(dirname ${shq(path)})"; cat > ${shq(path)} <<'ATMEZEOF'\n${content}ATMEZEOF`;

  // shell ternary picking a per-color value based on a color var ($TARGET or $OLD)
  const pick = (colorVar, blue, green) => `$([ "$${colorVar}" = blue ] && echo ${blue} || echo ${green})`;

  for (const step of plan.steps) {
    switch (step.type) {
      case "determine_active":
        push("determine_active (TARGET=idle, OLD=current)", `${readColors}; echo "live=$ACTIVE target=$TARGET old=$OLD"`);
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
        push(`write_env ${step.path} (from $${step.secretName})`, `mkdir -p "$(dirname ${shq(step.path)})"; printf '%s' "$${step.secretName}" > ${shq(step.path)}; chmod 600 ${shq(step.path)}`);
        break;
      case "write_compose":
        push("write_compose (blue)", writeFile(step.blueFile, step.blueContent));
        push("write_compose (green)", writeFile(step.greenFile, step.greenContent));
        break;
      case "compose_up": {
        const env = step.envFile ? `--env-file ${shq(step.envFile)} ` : "";
        const p = step.projectName ? `-p ${shq(step.projectName)} ` : "";
        push(`compose_up ${step.file}`, `docker compose ${p}${env}-f ${shq(step.file)} up -d`);
        break;
      }
      case "compose_pull_target":
        push("compose_pull_target", `${readColors}; docker compose -p ${step.project}-$TARGET -f ${shq(step.projectRoot)}/$TARGET/docker-compose.app.yml pull`);
        break;
      case "compose_up_target":
        push("compose_up_target (--force-recreate)", `${readColors}; docker compose -p ${step.project}-$TARGET -f ${shq(step.projectRoot)}/$TARGET/docker-compose.app.yml up -d --force-recreate`);
        break;
      case "compose_down_old":
        push("compose_down_old", `${readColors}; docker compose -p ${step.project}-$OLD -f ${shq(step.projectRoot)}/$OLD/docker-compose.app.yml down`);
        break;
      case "compose_up_old":
        push("compose_up_old (ensure previous color up)", `${readColors}; docker compose -p ${step.project}-$OLD -f ${shq(step.projectRoot)}/$OLD/docker-compose.app.yml up -d`);
        break;
      case "migrate":
        push(`migrate (${step.service})`, `${readColors}; docker exec ${step.project}-$TARGET-${step.service}-1 sh -lc ${shq(step.command)}`);
        break;
      case "health_check_target": {
        // curl -fs on each service's TARGET port, up to 20 retries (like deploy-backend.sh)
        const probes = step.services
          .map((svc) => {
            const port = pick("TARGET", svc.blue, svc.green);
            return (
              `P=${port}; ok=0; for i in $(seq 1 20); do ` +
              `if curl -fs http://localhost:$P${svc.path} >/dev/null; then ok=1; echo "healthy ${svc.name}"; break; fi; ` +
              `echo "retry ${svc.name} ($i)"; sleep 3; done; ` +
              `[ "$ok" = 1 ] || (echo "unhealthy ${svc.name} on :$P"; docker logs ${step.project}-$TARGET-${svc.name}-1 2>&1 | tail -n 30 || true; exit 1)`
            );
          })
          .join("; ");
        push("health_check_target (curl -fs, 20 retries)", `${readColors}; ${probes}`);
        break;
      }
      case "bootstrap_nginx_if_missing": {
        // Only write the HTTP config + certbot the FIRST time (conf absent). On later
        // deploys the conf already exists (with Certbot's SSL) and we leave it alone.
        const writeConf =
          `if [ "$TARGET" = blue ]; then cat > ${shq(step.availPath)} <<'ATMEZEOF'\n${step.blueContent}ATMEZEOF\n` +
          `else cat > ${shq(step.availPath)} <<'ATMEZEOF'\n${step.greenContent}ATMEZEOF\n fi`;
        const certbot =
          step.sslDomains.length > 0
            ? ` && certbot --nginx --non-interactive --agree-tos --keep-until-expiring ${step.sslDomains.map((d) => `-d ${shq(d)}`).join(" ")} || echo "certbot skipped/failed"`
            : "";
        push(
          "bootstrap_nginx_if_missing (first deploy only)",
          `${readColors}; if [ ! -f ${shq(step.availPath)} ]; then ${writeConf}; ln -sfn ${shq(step.availPath)} ${shq(step.enabledPath)}; nginx -t && (systemctl reload nginx || nginx -s reload)${certbot}; else echo "nginx conf exists; preserving (SSL kept)"; fi`,
        );
        break;
      }
      case "switch_ports": {
        // sed each `set $<svc>_port N;` to the resolved color's port in the EXISTING conf.
        // This preserves any Certbot SSL directives already in the file.
        const seds = step.portVars
          .map((pv) => {
            const colorVar = pv.color === "old" ? "OLD" : "TARGET";
            const val = pick(colorVar, pv.blue, pv.green);
            return `sed -i "s/set \\$${pv.var} .*/set \\$${pv.var} ${val};/" ${shq(step.availPath)}`;
          })
          .join("; ");
        push("switch_ports (sed set $<svc>_port in existing conf)", `${readColors}; ${seds}`);
        break;
      }
      case "nginx_reload":
        push("nginx_reload (test + reload)", `nginx -t && (systemctl reload nginx || nginx -s reload)`);
        break;
      case "verify_live": {
        const checks = step.checks
          .map((c) => {
            const scheme = c.ssl ? "https" : "http";
            return `curl -fsk ${scheme}://${c.domain}${c.path} >/dev/null || (echo "verify failed ${c.domain}"; exit 1)`;
          })
          .join("; ");
        push("verify_live (curl -fs per domain)", checks);
        break;
      }
      case "write_active_marker":
        push("write_active_marker (echo TARGET)", `${readColors}; mkdir -p "$(dirname ${shq(step.markerPath)})"; echo "$TARGET" > ${shq(step.markerPath)}`);
        break;
      case "write_active_marker_old":
        push("write_active_marker (echo OLD, rollback)", `${readColors}; mkdir -p "$(dirname ${shq(step.markerPath)})"; echo "$OLD" > ${shq(step.markerPath)}`);
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
