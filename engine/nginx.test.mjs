// Unit tests for nginx config generation (acadlynk-style). Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderProjectNginx } from "./nginx.mjs";

const uploadsPath = "/opt/acadlynk/shared/uploads";

test("renders a server block per service with set $port and snippet includes", () => {
  const cfg = renderProjectNginx({
    project: "acadlynk",
    uploadsPath,
    blocks: [
      { service: "web", domain: "acadlynk.com", port: 8096 },
      { service: "backend", domain: "api.acadlynk.com", port: 5002 },
    ],
  });
  assert.match(cfg, /server_name acadlynk\.com;/);
  assert.match(cfg, /set \$web_port 8096;/);
  assert.match(cfg, /set \$backend_port 5002;/);
  assert.match(cfg, /include \/etc\/nginx\/snippets\/security\.conf;/);
  assert.match(cfg, /include \/etc\/nginx\/snippets\/proxy\.conf;/);
});

test("backend role gets /uploads alias + php-deny guard", () => {
  const cfg = renderProjectNginx({
    project: "acadlynk",
    uploadsPath,
    blocks: [{ service: "backend", domain: "api.acadlynk.com", port: 5002 }],
  });
  assert.match(cfg, /location \/uploads\/ \{/);
  assert.match(cfg, /alias \/opt\/acadlynk\/shared\/uploads\/;/);
  assert.match(cfg, /\^\/uploads\/\.\*\\\.\(php/);
});

test("admin role proxies /api/ to the backend port", () => {
  const cfg = renderProjectNginx({
    project: "acadlynk",
    uploadsPath,
    blocks: [{ service: "admin", domain: "admin.acadlynk.com", port: 8094, backendPort: 5002 }],
  });
  assert.match(cfg, /set \$backend_port 5002;/);
  assert.match(cfg, /location \/api\/ \{/);
});

test("emits HTTP-only (no SSL lines) so Certbot can add TLS afterwards", () => {
  const cfg = renderProjectNginx({
    project: "acadlynk",
    uploadsPath,
    blocks: [{ service: "web", domain: "acadlynk.com", port: 8096 }],
  });
  assert.ok(!/ssl_certificate/.test(cfg));
  assert.ok(!/listen 443/.test(cfg));
  assert.match(cfg, /listen 80;/); // redirect/serve stub present
});

test("admin without backendPort is rejected", () => {
  assert.throws(
    () =>
      renderProjectNginx({
        project: "p",
        uploadsPath,
        blocks: [{ service: "admin", domain: "a.com", port: 8094 }],
      }),
    /backendPort/,
  );
});

test("deterministic for identical inputs", () => {
  const args = { project: "p", uploadsPath, blocks: [{ service: "web", domain: "x.com", port: 8096 }] };
  assert.equal(renderProjectNginx(args), renderProjectNginx(args));
});
