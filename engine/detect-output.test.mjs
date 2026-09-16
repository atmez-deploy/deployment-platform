// Unit tests for build-output auto-detection. Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveOutputDir } from "../tools/detect-output.mjs";

const before = [
  { name: "src", mtimeMs: 100 },
  { name: "public", mtimeMs: 100 }, // pre-existing source assets
];

test("explicit config value always wins", () => {
  const r = resolveOutputDir({ explicit: "dist", before, after: before });
  assert.equal(r.dir, "dist");
  assert.match(r.reason, /explicit/);
});

test("detects a newly-created known output dir", () => {
  const after = [...before, { name: "dist", mtimeMs: 200 }];
  assert.equal(resolveOutputDir({ before, after }).dir, "dist");
});

test("detects when a known dir's mtime advanced during the build", () => {
  const after = [
    { name: "src", mtimeMs: 100 },
    { name: "public", mtimeMs: 300 }, // build wrote into public/
  ];
  assert.equal(resolveOutputDir({ before, after }).dir, "public");
});

test("prefers known-name order when several known dirs changed", () => {
  const after = [
    { name: "src", mtimeMs: 100 },
    { name: "build", mtimeMs: 200 },
    { name: "dist", mtimeMs: 200 },
  ];
  // dist has higher preference than build
  assert.equal(resolveOutputDir({ before, after }).dir, "dist");
});

test("uses the single changed dir even if not a known name", () => {
  const after = [...before, { name: "weird-out", mtimeMs: 200 }];
  assert.equal(resolveOutputDir({ before, after }).dir, "weird-out");
});

test("throws when nothing changed", () => {
  assert.throws(() => resolveOutputDir({ before, after: before }), /could not detect/);
});

test("throws (ambiguous) when multiple unknown dirs changed", () => {
  const after = [...before, { name: "aaa", mtimeMs: 200 }, { name: "bbb", mtimeMs: 200 }];
  assert.throws(() => resolveOutputDir({ before, after }), /ambiguous/);
});
