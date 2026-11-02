import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ANDROID_MIN_FREE_GB, MIN_FREE_GB, hashInputs, planBuilds } from "./fork-build-lib.mjs";

function repoWith(files) {
  const root = mkdtempSync(path.join(os.tmpdir(), "fork-build-lib-"));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
  execFileSync("git", ["add", "."], { cwd: root });
  return root;
}

test("a package stamp goes stale on an uncommitted edit or a new untracked source", (t) => {
  const root = repoWith({ ".gitignore": "dist/\n", "pkg/src/a.ts": "a", "pkg/package.json": "{}" });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const built = hashInputs(root, ["pkg"]);

  writeFileSync(path.join(root, "pkg/src/a.ts"), "a2");
  const edited = hashInputs(root, ["pkg"]);
  assert.notEqual(edited, built);

  writeFileSync(path.join(root, "pkg/src/b.ts"), "b");
  assert.notEqual(hashInputs(root, ["pkg"]), edited);
});

test("build outputs and files outside the inputs leave the stamp fresh", (t) => {
  const root = repoWith({ ".gitignore": "dist/\n", "pkg/src/a.ts": "a", "other/x.ts": "x" });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const built = hashInputs(root, ["pkg"]);

  mkdirSync(path.join(root, "pkg/dist"));
  writeFileSync(path.join(root, "pkg/dist/a.js"), "compiled");
  writeFileSync(path.join(root, "other/x.ts"), "x2");
  assert.equal(hashInputs(root, ["pkg"]), built);
});

test("a deleted tracked source and a changed Node version both go stale", (t) => {
  const root = repoWith({ "pkg/a.ts": "a", "pkg/b.ts": "b" });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const built = hashInputs(root, ["pkg"], ["node v24.1.0"]);

  assert.notEqual(hashInputs(root, ["pkg"], ["node v24.2.0"]), built);
  rmSync(path.join(root, "pkg/b.ts"));
  assert.notEqual(hashInputs(root, ["pkg"], ["node v24.1.0"]), built);
});

test("builds stop below the disk floor", () => {
  assert.ok(planBuilds({ freeGb: MIN_FREE_GB - 0.1, android: true }).stop);
  assert.equal(planBuilds({ freeGb: MIN_FREE_GB, android: false }).android, "skip");
});

test("the APK runs beside the desktop build only when the disk holds both", () => {
  const both = MIN_FREE_GB + ANDROID_MIN_FREE_GB;
  assert.equal(planBuilds({ freeGb: both, android: true }).android, "parallel");
  assert.equal(planBuilds({ freeGb: both - 0.1, android: true }).android, "after-desktop");
  assert.equal(planBuilds({ freeGb: ANDROID_MIN_FREE_GB, android: true }).android, "after-desktop");
  assert.equal(planBuilds({ freeGb: ANDROID_MIN_FREE_GB - 0.1, android: true }).android, "no-disk");
});
