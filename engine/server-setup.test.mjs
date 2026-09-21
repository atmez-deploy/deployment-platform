import { test } from "node:test";
import assert from "node:assert/strict";
import { planServerSetup } from "./server-setup.mjs";
import { toCommands, renderCommands } from "./executor.mjs";

const conn = { host: "203.0.113.20", port: 22, username: "root" };

test("full setup includes docker, nginx/certbot, enable, user, key, base path", () => {
  const plan = planServerSetup({ basePath: "/opt", deployUser: "deployer", publicKey: "ssh-ed25519 AAAA test" });
  const labels = plan.steps.map((s) => s.label);
  assert.ok(labels.some((l) => l.includes("docker")));
  assert.ok(labels.some((l) => l.includes("nginx + certbot")));
  assert.ok(labels.some((l) => l.includes("enable")));
  assert.ok(labels.some((l) => l.includes("deploy user deployer")));
  assert.ok(labels.some((l) => l.includes("authorize deploy key")));
  assert.ok(labels.some((l) => l.includes("base path /opt")));
});

test("docker install is idempotent (only if missing)", () => {
  const plan = planServerSetup({ deployUser: "d", publicKey: "k" });
  const docker = plan.steps.find((s) => s.label.includes("docker (if missing)"));
  assert.match(docker.command, /command -v docker/);
});

test("authorize-key step appends only if not already present", () => {
  const plan = planServerSetup({ deployUser: "d", publicKey: "ssh-ed25519 KEY x" });
  const auth = plan.steps.find((s) => s.label.startsWith("authorize"));
  assert.match(auth.command, /grep -qF .*authorized_keys \|\| echo/);
});

test("no deploy user => no user/key steps, base path owned by root", () => {
  const plan = planServerSetup({ basePath: "/srv" });
  assert.ok(!plan.steps.some((s) => s.label.startsWith("ensure deploy user")));
  assert.ok(!plan.steps.some((s) => s.label.startsWith("authorize")));
  const base = plan.steps.find((s) => s.label.includes("base path"));
  assert.match(base.command, /chown root:root \/srv/);
});

test("skipPackages omits the install steps", () => {
  const plan = planServerSetup({ installPackages: false, basePath: "/opt" });
  assert.ok(!plan.steps.some((s) => s.label.includes("docker")));
  assert.ok(!plan.steps.some((s) => s.label.includes("nginx")));
});

test("compiles to ssh commands carrying the key path, no key material", () => {
  const plan = planServerSetup({ deployUser: "d", publicKey: "ssh-ed25519 PUB x" });
  const cmds = toCommands(plan, conn, { keyPath: "/tmp/k" });
  assert.ok(cmds.every((c) => c.bin === "ssh"));
  const rendered = renderCommands(cmds);
  assert.ok(rendered.includes("/tmp/k"));
  assert.ok(!rendered.includes("BEGIN OPENSSH PRIVATE KEY"));
  // the public key IS present (it's not secret) — that's expected
  assert.ok(rendered.includes("ssh-ed25519 PUB x"));
});

test("invalid deploy user name is rejected", () => {
  assert.throws(() => planServerSetup({ deployUser: "Bad User" }), /invalid deploy user/);
});
