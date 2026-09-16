// Pure docker-compose generation, modeled on the real acadlynk blue/green layout.
//
// Per-color app compose (blue/green/docker-compose.app.yml) and an optional DB compose
// (db/docker-compose.db.yml). Generated from the project config's services + the
// allocator's ports + deployer inputs (image tag) + shared env files. Secrets are NOT
// embedded: services reference `env_file: ../shared/<service>.env` which the deploy step
// writes from the SecretProvider at run time.
//
// This mirrors what the deployer already runs by hand (deploy-*.sh + compose files), so
// the engine can replace those scripts without changing the proven runtime shape.

function yamlList(items, indent) {
  return items.map((i) => `${" ".repeat(indent)}- ${i}`).join("\n");
}

/**
 * Render a per-color app compose file.
 * @param {Object} args
 * @param {string} args.project
 * @param {string} args.color            "blue" | "green"
 * @param {string} args.network          external docker network name
 * @param {Array}  args.services         [{ name, image, containerPort, hostPort, envFile?, volumes?, tz? }]
 *   - image: full immutable ref (…@sha256 or :tag)
 *   - containerPort: port the app listens on inside the container
 *   - hostPort: 127.0.0.1:<hostPort> to bind (from the allocator)
 * @returns {string} docker-compose YAML
 */
export function renderAppCompose({ project, color, network, services }) {
  if (!project || !color || !network) throw new Error("project/color/network required");
  if (!Array.isArray(services) || services.length === 0) throw new Error("services required");

  const lines = ["services:"];
  for (const s of services) {
    if (!s.name || !s.image) throw new Error(`service needs name+image`);
    if (!Number.isInteger(s.containerPort) || !Number.isInteger(s.hostPort)) {
      throw new Error(`service '${s.name}' needs integer containerPort+hostPort`);
    }
    lines.push(`  ${s.name}:`);
    lines.push(`    image: ${s.image}`);
    lines.push(`    container_name: ${project}-${color}-${s.name}-1`);
    lines.push(`    restart: unless-stopped`);
    if (s.envFile) {
      lines.push(`    env_file:`);
      lines.push(`      - ${s.envFile}`);
    }
    lines.push(`    environment:`);
    lines.push(`      TZ: ${s.tz ?? "Asia/Kolkata"}`);
    const vols = [
      ...(s.volumes ?? []),
      "/etc/localtime:/etc/localtime:ro",
      "/etc/timezone:/etc/timezone:ro",
    ];
    lines.push(`    volumes:`);
    lines.push(yamlList(vols, 6));
    lines.push(`    ports:`);
    lines.push(`      - "127.0.0.1:${s.hostPort}:${s.containerPort}"`);
    lines.push(`    networks:`);
    lines.push(`      - ${network}`);
  }
  lines.push(`networks:`);
  lines.push(`  ${network}:`);
  lines.push(`    external: true`);
  return lines.join("\n") + "\n";
}

/**
 * Render the DB compose (postgres by default), modeled on acadlynk's db compose.
 * DB credentials come from env at run time via ${VAR} interpolation that docker compose
 * resolves from the db/.env file — NOT hardcoded here.
 * @param {Object} args
 * @param {string} args.project
 * @param {string} args.network
 * @param {Object} [args.db]  { image?, hostPort?, volumeName? }
 * @returns {string} docker-compose YAML
 */
export function renderDbCompose({ project, network, db = {} }) {
  if (!project || !network) throw new Error("project/network required");
  const image = db.image ?? "postgres:16-alpine";
  const hostPort = db.hostPort ?? 5432;
  const volume = db.volumeName ?? `${project}_postgres_data`;
  return (
    `services:\n` +
    `  postgres:\n` +
    `    image: ${image}\n` +
    `    container_name: ${project}_postgres\n` +
    `    restart: unless-stopped\n` +
    `    environment:\n` +
    `      POSTGRES_USER: \${POSTGRES_USER}\n` +
    `      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}\n` +
    `      POSTGRES_DB: \${POSTGRES_DB}\n` +
    `    ports:\n` +
    `      - "127.0.0.1:${hostPort}:5432"\n` +
    `    volumes:\n` +
    `      - ${volume}:/var/lib/postgresql/data\n` +
    `    networks:\n` +
    `      - ${network}\n` +
    `    healthcheck:\n` +
    `      test: ["CMD-SHELL", "pg_isready -U \${POSTGRES_USER} -d \${POSTGRES_DB}"]\n` +
    `      interval: 10s\n      timeout: 5s\n      retries: 5\n      start_period: 10s\n` +
    `volumes:\n` +
    `  ${volume}:\n` +
    `    name: ${volume}\n` +
    `networks:\n` +
    `  ${network}:\n` +
    `    external: true\n`
  );
}
