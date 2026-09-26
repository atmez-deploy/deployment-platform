import { test } from "node:test";
import assert from "node:assert/strict";
import { detectBuild } from "../tools/detect-build.mjs";

test("npm project with build script -> npm ci && npm run build", () => {
  const r = detectBuild({ files: ["package.json", "package-lock.json", "src"], packageJson: { scripts: { build: "vite build" } } });
  assert.equal(r.command, "npm ci && npm run build");
  assert.equal(r.packageManager, "npm");
});

test("pnpm lockfile -> pnpm build", () => {
  const r = detectBuild({ files: ["package.json", "pnpm-lock.yaml"], packageJson: { scripts: { build: "next build" } } });
  assert.equal(r.command, "pnpm install --frozen-lockfile && pnpm run build");
  assert.equal(r.packageManager, "pnpm");
});

test("yarn lockfile -> yarn build", () => {
  const r = detectBuild({ files: ["package.json", "yarn.lock"], packageJson: { scripts: { build: "webpack" } } });
  assert.equal(r.command, "yarn install --frozen-lockfile && yarn build");
  assert.equal(r.packageManager, "yarn");
});

test("npm build script but NO lockfile -> npm install (not ci)", () => {
  const r = detectBuild({ files: ["package.json"], packageJson: { scripts: { build: "vite build" } } });
  assert.equal(r.command, "npm install && npm run build");
});

test("Hugo site -> hugo --minify", () => {
  const r = detectBuild({ files: ["config.toml", "content", "layouts"], packageJson: null });
  assert.equal(r.command, "hugo --minify");
});

test("hugo.toml alone -> hugo", () => {
  const r = detectBuild({ files: ["hugo.toml", "content"], packageJson: null });
  assert.match(r.command, /^hugo/);
});

test("Jekyll site -> bundle exec jekyll build", () => {
  const r = detectBuild({ files: ["_config.yml", "Gemfile", "index.md"], packageJson: null });
  assert.match(r.command, /jekyll build/);
});

test("Node project without a build script -> no build", () => {
  const r = detectBuild({ files: ["package.json", "index.html"], packageJson: { scripts: { test: "jest" } } });
  assert.equal(r.command, "");
  assert.match(r.reason, /no build script/);
});

test("plain HTML -> no build", () => {
  const r = detectBuild({ files: ["index.html", "style.css", "img"], packageJson: null });
  assert.equal(r.command, "");
  assert.match(r.reason, /plain HTML/);
});

test("empty build script is treated as no build", () => {
  const r = detectBuild({ files: ["package.json"], packageJson: { scripts: { build: "  " } } });
  assert.equal(r.command, "");
});

test("nothing recognizable -> no build (safe)", () => {
  const r = detectBuild({ files: ["README.md", "LICENSE"], packageJson: null });
  assert.equal(r.command, "");
});

test("deterministic for identical input", () => {
  const input = { files: ["package.json", "package-lock.json"], packageJson: { scripts: { build: "vite build" } } };
  assert.deepEqual(detectBuild(input), detectBuild(input));
});
