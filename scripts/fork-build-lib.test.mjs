import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  ANDROID_MIN_FREE_GB,
  buildMessage,
  hashInputs,
  MIN_FREE_GB,
  planBuilds,
  syncAgentPrompt,
  syncOutcome,
} from "./fork-build-lib.mjs";

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
  assert.equal(planBuilds({ freeGb: MIN_FREE_GB, android: true }).android, "after-desktop");
});

test("a green build says so; skipped PRs and failed checks name the PRs and the way on", () => {
  const base = { exitCode: 0, summary: "# Fork build\n- ok", notifyId: "abc", logDir: "/logs" };
  const green = buildMessage({
    ...base,
    prs: [1],
    result: { code: 0, merged: ["#1 t"], skipped: [] },
  });
  assert.match(green, /^Fork build finished: green/);
  assert.match(green, /# Fork build/);

  const partial = buildMessage({
    ...base,
    prs: [1, 2, 3],
    result: {
      code: 0,
      merged: ["#1 t"],
      skipped: ["#2 b: conflicts with main in a.ts", "#3 c: draft"],
    },
  });
  assert.match(partial, /#2, #3/);
  assert.match(partial, /--notify abc --pr 2 --pr 3\n/);

  const failed = buildMessage({
    ...base,
    exitCode: 1,
    prs: [1, 2],
    result: { code: 1, merged: ["#1 t"], skipped: [] },
  });
  assert.match(failed, /FAILED \(exit 1\)/);
  assert.match(failed, /origin\/main/);
  assert.match(failed, /--notify abc --pr 1 --pr 2/);

  const crashed = buildMessage({ ...base, exitCode: 127, prs: [1], result: null });
  assert.match(crashed, /CRASHED \(exit 127\)/);
});

test("fork-sync exit codes pick no agent, a skip, a resolver agent, or a crash", () => {
  assert.equal(syncOutcome(0).kind, "done");
  assert.equal(syncOutcome(3).kind, "skip");
  assert.equal(syncOutcome(1).kind, "agent");
  assert.equal(syncOutcome(2).kind, "agent");
  assert.equal(syncOutcome(137).kind, "crash");
  const input = { why: "w", reportPath: "/r.md", checkout: "/c", worktree: "/c-sync" };
  assert.match(syncAgentPrompt({ ...input, code: 2 }), /fork-sync\.mjs --apply` from \/c/);
  assert.match(syncAgentPrompt({ ...input, code: 1 }), /commits on top of it/);
});
