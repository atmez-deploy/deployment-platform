// Pure nginx site-config generation for a domain-exposed service.
// Renders an HTTP server block whose upstream points at the given host port
// (the port of the color currently going live). SSL is a later phase (Rule 13):
// for ssl:true we emit an explicit TODO comment rather than fake cert handling.

/**
 * @param {Object} args
 * @param {string} args.domain        server_name
 * @param {number} args.port          upstream port on 127.0.0.1
 * @param {string} args.upstreamName  unique upstream id (e.g. example-app-staging-backend)
 * @param {boolean|"managed_by_provider"} [args.ssl]
 * @returns {string} nginx config text
 */
export function renderSiteConfig({ domain, port, upstreamName, ssl = false }) {
  if (!domain) throw new Error("domain is required");
  if (!Number.isInteger(port)) throw new Error("port must be an integer");
  if (!upstreamName) throw new Error("upstreamName is required");

  const sslNote =
    ssl === true
      ? "    # TODO(ssl): Certbot-managed TLS is a later phase; serving HTTP for now.\n"
      : "";

  return (
    `# Managed by atmez-deploy. Do not edit by hand.\n` +
    `upstream ${upstreamName} {\n` +
    `    server 127.0.0.1:${port};\n` +
    `}\n\n` +
    `server {\n` +
    `    listen 80;\n` +
    `    server_name ${domain};\n\n` +
    sslNote +
    `    location / {\n` +
    `        proxy_pass http://${upstreamName};\n` +
    `        proxy_set_header Host $host;\n` +
    `        proxy_set_header X-Real-IP $remote_addr;\n` +
    `        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n` +
    `        proxy_set_header X-Forwarded-Proto $scheme;\n` +
    `    }\n` +
    `}\n`
  );
}
