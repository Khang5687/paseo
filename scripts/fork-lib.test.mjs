import assert from "node:assert/strict";
import { test } from "node:test";
import {
  conflictOwners,
  featureVerdicts,
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
  files: ["packages/app/src/composer/daemon-queue.ts"],
};
const relay = {
  pr: 57,
  title: "relay hello rejection",
  tests: ["packages/server/src/server/websocket-server.relay-reconnect.test.ts"],
  files: ["packages/server/src/server/websocket-server.ts"],
};
const docs = { pr: 8, title: "handoff docs", untested: "docs only", tests: [], files: [] };

test("a test upstream deleted fails validation, a moved owned file only warns", () => {
  const exists = (file) => file !== queue.tests[0] && file !== relay.files[0];
  const { errors, warnings } = validateFeatures([queue, relay, docs], { exists, mergedPrs: [] });
  assert.deepEqual(errors, [
    "#58: test packages/app/src/composer/daemon-queue.test.ts no longer exists (moved or deleted upstream?).",
  ]);
  assert.deepEqual(warnings, [
    "#57: owned file packages/server/src/server/websocket-server.ts no longer exists.",
  ]);
});

test("a merged fork PR without an entry, or an entry with nothing guarding it, fails", () => {
  const bare = { pr: 60, title: "new feature", tests: [], files: [] };
  const { errors } = validateFeatures([queue, bare], {
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
  assert.deepEqual(
    validateFeatures([retired], { exists: () => false, mergedPrs: [58] }).errors,
    [],
  );
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

test("the risk report names fork features an upstream commit touches, most-touched first", () => {
  const commits = parseNameStatusLog(
    [
      "\0abc1234\tfix(queue): rework queue track",
      "M\tpackages/app/src/composer/daemon-queue.ts",
      "D\tpackages/app/src/composer/daemon-queue.test.ts",
      "",
      "\0def5678\trefactor: move relay code",
      "R100\tpackages/server/src/server/websocket-server.ts\tpackages/server/src/server/ws/server.ts",
      "",
      "\0fed9876\tfix(queue): another queue change",
      "M\tpackages/app/src/composer/daemon-queue.ts",
      "",
      "\0aaa0000\tdocs: unrelated",
      "M\tdocs/product.md",
    ].join("\n"),
  );
  assert.deepEqual(riskReport([relay, queue], commits), [
    {
      pr: 58,
      title: queue.title,
      commits: [
        {
          sha: "abc1234",
          subject: "fix(queue): rework queue track",
          files: [
            "packages/app/src/composer/daemon-queue.ts",
            "packages/app/src/composer/daemon-queue.test.ts (deleted)",
          ],
        },
        {
          sha: "fed9876",
          subject: "fix(queue): another queue change",
          files: ["packages/app/src/composer/daemon-queue.ts"],
        },
      ],
    },
    {
      pr: 57,
      title: relay.title,
      commits: [
        {
          sha: "def5678",
          subject: "refactor: move relay code",
          files: ["packages/server/src/server/websocket-server.ts"],
        },
      ],
    },
  ]);
});

test("conflicted files are attributed to the fork PRs that own them", () => {
  assert.deepEqual(
    conflictOwners([queue, relay], ["packages/app/src/composer/daemon-queue.ts", "README.md"]),
    [
      { file: "packages/app/src/composer/daemon-queue.ts", prs: [58] },
      { file: "README.md", prs: [] },
    ],
  );
});
