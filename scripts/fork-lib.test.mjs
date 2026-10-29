import assert from "node:assert/strict";
import { test } from "node:test";
import {
  conflictBlocks,
  featureVerdicts,
  forkOwnersAt,
  parseBlameOwners,
  parseHunks,
  parseNameStatusLog,
  planTestRuns,
  playwrightFileResults,
  riskReport,
  validateFeatures,
  vitestFileResults,
} from "./fork-lib.mjs";

const queue = {
  pr: 58,
  title: "keep images on queued messages",
  tests: ["packages/app/src/composer/daemon-queue.test.ts"],
  e2e: ["packages/app/e2e/browser/queue-controls.spec.ts"],
};
const relay = {
  pr: 57,
  title: "relay hello rejection",
  tests: ["packages/server/src/server/websocket-server.relay-reconnect.test.ts"],
};
const docs = { pr: 8, title: "handoff docs", untested: "docs only", tests: [] };

test("a test upstream deleted fails validation", () => {
  const exists = (file) => file !== queue.tests[0];
  assert.deepEqual(validateFeatures([queue, relay, docs], { exists, mergedPrs: [] }), [
    "#58: test packages/app/src/composer/daemon-queue.test.ts no longer exists (moved or deleted upstream?).",
  ]);
});

test("a merged fork PR without an entry, or an entry with nothing guarding it, fails", () => {
  const bare = { pr: 60, title: "new feature", tests: [] };
  const errors = validateFeatures([queue, bare], {
    exists: () => true,
    mergedPrs: [58, 59, 60],
  });
  assert.deepEqual(errors, [
    "#59 is merged on main but has no entry in scripts/fork-features.json.",
    '#60 lists no tests and no "untested" reason.',
  ]);
});

test("retired features are neither validated nor run", () => {
  const retired = { ...queue, retired: "upstream shipped its own" };
  assert.deepEqual(validateFeatures([retired], { exists: () => false, mergedPrs: [58] }), []);
  assert.deepEqual(featureVerdicts([retired], new Map()), []);
});

test("test runs split by package, with app browser tests in the browser project", () => {
  const runs = planTestRuns([
    "packages/app/src/a.test.ts",
    "packages/app/src/b.browser.test.tsx",
    "packages/server/src/c.test.ts",
    "plugins/muse-provider/test/provider.test.ts",
    "scripts/fork-lib.test.mjs",
    "packages/app/src/a.test.ts",
  ]);
  assert.deepEqual(
    runs.map((run) => [run.kind, run.cwd, run.project, run.files]),
    [
      ["vitest", "packages/app", "unit", ["packages/app/src/a.test.ts"]],
      ["vitest", "packages/app", "browser", ["packages/app/src/b.browser.test.tsx"]],
      ["vitest", "packages/server", undefined, ["packages/server/src/c.test.ts"]],
      ["vitest", "plugins", undefined, ["plugins/muse-provider/test/provider.test.ts"]],
      ["node-test", ".", undefined, ["scripts/fork-lib.test.mjs"]],
    ],
  );
});

test("a test file missing from the runner's report counts as failed", () => {
  const report = {
    testResults: [{ name: "/repo/packages/app/src/a.test.ts", status: "passed" }],
  };
  const results = vitestFileResults(report, "/repo", [
    "packages/app/src/a.test.ts",
    "packages/app/src/crashed.test.ts",
  ]);
  assert.deepEqual(
    [...results],
    [
      ["packages/app/src/a.test.ts", true],
      ["packages/app/src/crashed.test.ts", false],
    ],
  );
  assert.equal(vitestFileResults(null, "/repo", ["x.test.ts"]).get("x.test.ts"), false);
});

test("a spec file fails if any test in any nested describe failed", () => {
  const report = {
    suites: [
      {
        file: "queue-controls.spec.ts",
        specs: [{ ok: true }],
        suites: [{ specs: [{ ok: false }] }],
      },
      { file: "skins.spec.ts", specs: [{ ok: true }] },
    ],
  };
  const results = playwrightFileResults(report, "packages/app/e2e/browser", [
    "packages/app/e2e/browser/queue-controls.spec.ts",
    "packages/app/e2e/browser/skins.spec.ts",
  ]);
  assert.deepEqual([...results.values()], [false, true]);
});

test("a feature fails when any guard fails and is not-run when none ran", () => {
  const results = new Map([
    [queue.tests[0], true],
    [queue.e2e[0], false],
  ]);
  assert.deepEqual(
    featureVerdicts([queue, relay, docs], results).map((v) => [v.pr, v.status, v.failed]),
    [
      [58, "fail", [queue.e2e[0]]],
      [57, "not-run", []],
      [8, "untested", []],
    ],
  );
});

const FORK = "a".repeat(40);
const UPSTREAM = "b".repeat(40);

/** A blame of `lines`, where each entry is [owner, text] and owner "fork" means PR #57. */
function blameOf(lines) {
  const porcelain = lines
    .map(([owner, text], index) =>
      [
        `${owner === "fork" ? FORK : UPSTREAM} ${index + 1} ${index + 1} 1`,
        "author x",
        `\t${text}`,
      ].join("\n"),
    )
    .join("\n");
  return parseBlameOwners(porcelain, (sha) => (sha === FORK ? 57 : null));
}

const serverFile = blameOf([
  ["up", "const WS_CLOSE_SERVER_SHUTDOWN = 1001;"],
  ["up", "const WS_PROTOCOL_VERSION = 1;"],
  ["fork", "// Let relay clients read the rejection before the close."],
  ["fork", "export const RELAY_HELLO_REJECTION_CLOSE_DELAY_MS = 1_000;"],
  ["up", "const WS_RUNTIME_METRICS_FLUSH_MS = 30_000;"],
  ["up", "const OWNER_SESSION_ADMISSION = {"],
  ["up", "};"],
  ["up", ""],
  ["up", "function a() {"],
  ["up", "  return 1;"],
  ["up", "}"],
  ["up", ""],
  ["up", "function b() {"],
  ["up", "  return 2;"],
  ["up", "}"],
]);

test("blame lines written by a fork PR are owned by it, upstream lines by nobody", () => {
  assert.deepEqual(serverFile.owners.slice(0, 5), [null, null, 57, 57, null]);
  assert.equal(serverFile.lines[3], "export const RELAY_HELLO_REJECTION_CLOSE_DELAY_MS = 1_000;");
});

test("an upstream hunk next to fork lines names the fork PR; one far away names nobody", () => {
  const near = parseHunks(
    ["@@ -6,3 +6,3 @@", " const OWNER_SESSION_ADMISSION = {", "-};", "+} as const;", " "].join(
      "\n",
    ),
  );
  const far = parseHunks(
    ["@@ -13,3 +13,3 @@", " function b() {", "-  return 2;", "+  return 3;", " }"].join("\n"),
  );
  assert.deepEqual([...forkOwnersAt(serverFile, near, 3)], [57]);
  assert.deepEqual([...forkOwnersAt(serverFile, far, 3)], []);
});

test("an upstream hunk spanning lines the fork inserted between is found through its unique lines", () => {
  // Upstream's old side has the two constants adjacent; on fork main the fork's lines sit between.
  const hunks = parseHunks(
    [
      "@@ -2,2 +2,3 @@",
      " const WS_PROTOCOL_VERSION = 1;",
      "-const WS_RUNTIME_METRICS_FLUSH_MS = 30_000;",
      "+// Flush once a minute.",
      "+const WS_RUNTIME_METRICS_FLUSH_MS = 60_000;",
    ].join("\n"),
  );
  assert.deepEqual([...forkOwnersAt(serverFile, hunks, 0)], [57]);
});

test("a block that is not in the file and has no unique line names every fork PR in the file", () => {
  // "}" appears twice and never twice in a row, so the block cannot be placed.
  assert.deepEqual([...forkOwnersAt(serverFile, [["}", "}"]], 0)], [57]);
  assert.deepEqual([...forkOwnersAt(serverFile, [[]], 0)], [57]);
});

test("conflict blocks are the ours side, in both merge and diff3 marker styles", () => {
  const text = [
    "a",
    "<<<<<<< HEAD",
    "ours 1",
    "=======",
    "theirs 1",
    ">>>>>>> upstream/main",
    "b",
    "<<<<<<< HEAD",
    "ours 2",
    "||||||| base",
    "base 2",
    "=======",
    "theirs 2",
    ">>>>>>> upstream/main",
  ].join("\n");
  assert.deepEqual(conflictBlocks(text), [["ours 1"], ["ours 2"]]);
});

test("name-status logs keep each change's status, both paths of a rename", () => {
  const commits = parseNameStatusLog(
    [
      "\0abc1234\tfix(queue): rework queue track",
      "M\tpackages/app/src/composer/daemon-queue.ts",
      "D\tpackages/app/src/composer/daemon-queue.test.ts",
      "",
      "\0def5678\trefactor: move relay code",
      "R100\tpackages/server/src/server/websocket-server.ts\tpackages/server/src/server/ws/server.ts",
    ].join("\n"),
  );
  assert.deepEqual(commits, [
    {
      sha: "abc1234",
      subject: "fix(queue): rework queue track",
      changes: [
        { status: "M", file: "packages/app/src/composer/daemon-queue.ts" },
        { status: "D", file: "packages/app/src/composer/daemon-queue.test.ts" },
      ],
    },
    {
      sha: "def5678",
      subject: "refactor: move relay code",
      changes: [
        { status: "R", file: "packages/server/src/server/websocket-server.ts" },
        { status: "R", file: "packages/server/src/server/ws/server.ts" },
      ],
    },
  ]);
});

test("the risk report groups touches by fork owner, most-touched first", () => {
  const report = riskReport([
    { sha: "abc", subject: "one", file: "a.ts", owners: new Set([58]) },
    { sha: "abc", subject: "one", file: "b.ts", owners: new Set([58, 57]) },
    { sha: "def", subject: "two", file: "a.ts", owners: new Set([58]) },
  ]);
  assert.deepEqual(report, [
    {
      owner: 58,
      commits: [
        { sha: "abc", subject: "one", files: ["a.ts", "b.ts"] },
        { sha: "def", subject: "two", files: ["a.ts"] },
      ],
    },
    { owner: 57, commits: [{ sha: "abc", subject: "one", files: ["b.ts"] }] },
  ]);
});
