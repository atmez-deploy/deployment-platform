// Pure nginx config generation, modeled on the real acadlynk production layout.
//
// Design choices matched to the deployer's actual server:
//   - One file per project, multiple `server {}` blocks (one per domain-exposed service).
//   - `set $<role>_port N;` variables + `include /etc/nginx/snippets/*` (security, proxy,
//     deny-dotfiles) instead of inline proxy directives.
//   - HTTP-FIRST: we emit plain :80 server blocks. Certbot is run afterwards and rewrites
//     these to add :443 + cert lines (matching how the acadlynk file was produced).
//     So this module never fakes SSL (Rule 13); SSL is added by the certbot step.
//   - Service "roles" drive special handling:
//       web         -> proxy / to its port
//       api|backend -> proxy /, plus /uploads/ alias + rate limits
//       admin       -> proxy /, plus /api/ -> backend port
//       masteradmin -> proxy /
//
// This is generic: it reads whatever services the project config declares. acadlynk is
// just one instance.

const SNIPPETS = [
  "include /etc/nginx/snippets/security.conf;",
  "include /etc/nginx/snippets/deny-dotfiles.conf;",
];
const PROXY_INCLUDE = "        include /etc/nginx/snippets/proxy.conf;";

function roleOf(serviceName, explicitRole) {
  if (explicitRole) return explicitRole;
  const n = serviceName.toLowerCase();
  if (n === "web") return "web";
  if (n === "api" || n === "backend") return "backend";
  if (n === "admin") return "admin";
  if (n === "masteradmin") return "masteradmin";
  return "web"; // sensible default: proxy root
}

/**
 * Render an HTTP-only nginx config for a project.
 * @param {Object} args
 * @param {string} args.project
 * @param {string} args.uploadsPath  absolute path to shared uploads (for backend /uploads alias)
 * @param {Array} args.blocks  [{ service, role?, domain, port, backendPort? }]
 *   - port: the host port this service's live color is bound to
 *   - backendPort: required for admin role (to proxy /api/)
 * @param {number} [args.clientMaxBodyMb]
 * @returns {string} nginx config (HTTP only; Certbot adds TLS afterwards)
 */
export function renderProjectNginx({ project, uploadsPath, blocks, clientMaxBodyMb = 200 }) {
  if (!project) throw new Error("project is required");
  if (!Array.isArray(blocks) || blocks.length === 0) throw new Error("at least one block required");

  const parts = [`# Managed by atmez-deploy for project '${project}'. Do not edit by hand.`];

  for (const b of blocks) {
    if (!b.domain) throw new Error(`block for service '${b.service}' missing domain`);
    if (!Number.isInteger(b.port)) throw new Error(`block for service '${b.service}' missing integer port`);
    const role = roleOf(b.service, b.role);
    parts.push(renderServerBlock({ ...b, role, clientMaxBodyMb, uploadsPath }));
  }

  // HTTP->HTTPS redirect stubs per domain. Before SSL these simply serve; after Certbot
  // runs, Certbot manages the 443 side and these 80 blocks become the redirect.
  for (const b of blocks) {
    parts.push(
      `server {\n    listen 80;\n    server_name ${b.domain};\n    location / {\n        proxy_pass http://127.0.0.1:${b.port};\n${PROXY_INCLUDE}\n    }\n}`,
    );
  }

  return parts.join("\n\n") + "\n";
}

function renderServerBlock({ service, role, domain, port, backendPort, clientMaxBodyMb, uploadsPath }) {
  const head =
    `# --- ${service} (${role}) ---\n` +
    `server {\n` +
    `    server_name ${domain};\n` +
    `    client_max_body_size ${clientMaxBodyMb}M;\n` +
    `    ${SNIPPETS.join("\n    ")}\n` +
    `    set $${service}_port ${port};\n`;

  let body = "";

  if (role === "backend") {
    if (!uploadsPath) throw new Error("backend block needs uploadsPath");
    body +=
      `\n    location ~* ^/uploads/.*\\.(php|pl|py|cgi|sh|jsp|asp|aspx)$ {\n        deny all;\n    }\n` +
      `    location /uploads/ {\n        alias ${uploadsPath}/;\n        autoindex off;\n        access_log off;\n        expires 30d;\n        add_header Cache-Control "public, immutable";\n    }\n` +
      `    location / {\n        proxy_pass http://127.0.0.1:$${service}_port;\n${PROXY_INCLUDE}\n    }\n`;
  } else if (role === "admin") {
    if (!Number.isInteger(backendPort)) throw new Error("admin block needs backendPort");
    body +=
      `    set $backend_port ${backendPort};\n` +
      `\n    location /api/ {\n        proxy_pass http://127.0.0.1:$backend_port;\n${PROXY_INCLUDE}\n    }\n` +
      `    location / {\n        proxy_pass http://127.0.0.1:$${service}_port;\n${PROXY_INCLUDE}\n    }\n`;
  } else {
    // web / masteradmin / default: proxy root
    body += `\n    location / {\n        proxy_pass http://127.0.0.1:$${service}_port;\n${PROXY_INCLUDE}\n    }\n`;
  }

  return head + body + `}`;
}
