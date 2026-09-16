// Unit tests for compose generation. Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderAppCompose, renderDbCompose } from "./compose.mjs";

test("app compose mirrors the acadlynk per-color shape", () => {
  const yaml = renderAppCompose({
    project: "acadlynk",
    color: "blue",
    network: "acadlynk_network",
    services: [
      {
        name: "backend",
        image: "ghcr.io/org/acadlynk-backend:abc123",
        containerPort: 3000,
        hostPort: 5001,
        envFile: "../shared/backend.env",
        volumes: ["/opt/acadlynk/shared/uploads:/app/uploads"],
      },
      { name: "web", image: "ghcr.io/org/acadlynk-web:abc123", containerPort: 80, hostPort: 8095 },
    ],
  });
  assert.match(yaml, /container_name: acadlynk-blue-backend-1/);
  assert.match(yaml, /"127\.0\.0\.1:5001:3000"/);
  assert.match(yaml, /env_file:\n\s+- \.\.\/shared\/backend\.env/);
  assert.match(yaml, /- \/opt\/acadlynk\/shared\/uploads:\/app\/uploads/);
  assert.match(yaml, /networks:\n\s+acadlynk_network:\n\s+external: true/);
});

test("app compose rejects incomplete services", () => {
  assert.throws(
    () =>
      renderAppCompose({
        project: "p",
        color: "blue",
        network: "n",
        services: [{ name: "x", image: "i", containerPort: 80 }], // missing hostPort
      }),
    /hostPort/,
  );
});

test("db compose uses env interpolation, not hardcoded creds", () => {
  const yaml = renderDbCompose({ project: "acadlynk", network: "acadlynk_network", db: { hostPort: 5433 } });
  assert.match(yaml, /POSTGRES_USER: \$\{POSTGRES_USER\}/);
  assert.ok(!/AcadlynkDb2026Secure/.test(yaml)); // no real secret
  assert.match(yaml, /name: acadlynk_postgres_data/);
  assert.match(yaml, /"127\.0\.0\.1:5433:5432"/);
});

test("deterministic", () => {
  const a = renderDbCompose({ project: "p", network: "n" });
  const b = renderDbCompose({ project: "p", network: "n" });
  assert.equal(a, b);
});
