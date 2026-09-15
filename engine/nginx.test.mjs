// Unit tests for nginx config rendering. Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderSiteConfig } from "./nginx.mjs";

test("renders an upstream + server block pointing at the port", () => {
  const cfg = renderSiteConfig({
    domain: "api.example.com",
    port: 5001,
    upstreamName: "example-app-staging-backend",
  });
  assert.match(cfg, /upstream example-app-staging-backend \{/);
  assert.match(cfg, /server 127\.0\.0\.1:5001;/);
  assert.match(cfg, /server_name api\.example\.com;/);
  assert.match(cfg, /proxy_pass http:\/\/example-app-staging-backend;/);
});

test("ssl:true emits an explicit TODO note (no fake TLS)", () => {
  const cfg = renderSiteConfig({ domain: "x.com", port: 8100, upstreamName: "u", ssl: true });
  assert.match(cfg, /TODO\(ssl\)/);
});

test("deterministic for identical inputs", () => {
  const a = renderSiteConfig({ domain: "x.com", port: 8100, upstreamName: "u" });
  const b = renderSiteConfig({ domain: "x.com", port: 8100, upstreamName: "u" });
  assert.equal(a, b);
});

test("rejects bad inputs", () => {
  assert.throws(() => renderSiteConfig({ domain: "", port: 80, upstreamName: "u" }), /domain is required/);
  assert.throws(() => renderSiteConfig({ domain: "x", port: 1.5, upstreamName: "u" }), /port must be an integer/);
});
