#!/usr/bin/env node
// Fork-only (Khang5687/paseo); never upstreamed.
// Runs typecheck, lint, and every test listed in scripts/fork-features.json, then reports
// which fork PRs pass. See "Fork features and fork-check" in CLAUDE.md.
//
//   node scripts/fork-check.mjs                  typecheck + lint + unit tests
//   node scripts/fork-check.mjs --e2e            also the Playwright specs (starts Metro + daemon)
//   node scripts/fork-check.mjs --pr 55 --pr 58  only those features' tests
//   node scripts/fork-check.mjs --no-static      skip typecheck and lint
//   node scripts/fork-check.mjs --report <file>  also write the Markdown report there
//
// Workspace declarations must be built first (npm run build:server && npm run build:plugin).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  featureVerdicts,
  loadFeatures,
  mergedForkPrs,
  planTestRuns,
  playwrightFileResults,
  validateFeatures,
  vitestFileResults,
} from "./fork-lib.mjs";

const { values: args } = parseArgs({
  options: {
    e2e: { type: "boolean", default: false },
    "no-static": { type: "boolean", default: false },
    pr: { type: "string", multiple: true, default: [] },
    report: { type: "string" },
  },
});

const root = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout.trim();
const logDir = path.join(os.tmpdir(), `fork-check-${Date.now()}`);
mkdirSync(logDir, { recursive: true });
const progress = (message) => process.stderr.write(`[fork-check] ${message}\n`);

function run(name, command, commandArgs, { cwd = ".", env = {} } = {}) {
  const logPath = path.join(logDir, `${name}.log`);
  const started = Date.now();
  progress(`${name}: ${command} ${commandArgs.join(" ").slice(0, 160)}`);
  const result = spawnSync(command, commandArgs, {
    cwd: path.join(root, cwd),
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  writeFileSync(logPath, `${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  const seconds = Math.round((Date.now() - started) / 1000);
  progress(`${name}: exit ${result.status} in ${seconds}s (log ${logPath})`);
  return { ok: result.status === 0, logPath };
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const allFeatures = loadFeatures(root);
const selected = args.pr.length > 0 ? new Set(args.pr.map(Number)) : null;
const features = selected ? allFeatures.filter((f) => selected.has(f.pr)) : allFeatures;

const mergedPrs = (() => {
  const log = spawnSync(
    "git",
    ["log", "--first-parent", "--merges", "--format=%s", "HEAD", "--not", "upstream/main"],
    { cwd: root, encoding: "utf8" },
  );
  if (log.status !== 0) {
    progress("upstream/main not found; skipping the every-merged-PR-is-listed check");
    return [];
  }
  return selected ? [] : mergedForkPrs(log.stdout);
})();
const listErrors = validateFeatures(features, {
  exists: (file) => existsSync(path.join(root, file)),
  mergedPrs,
});

const staticResults = [];
if (!args["no-static"]) {
  staticResults.push({ name: "typecheck", ...run("typecheck", "npm", ["run", "typecheck"]) });
  staticResults.push({ name: "lint", ...run("lint", "npm", ["run", "lint"]) });
}

const results = new Map();
// Files that failed, then passed when rerun alone. A nightly run shares the machine with
// whatever else is going on, and timing-sensitive tests fail under load.
const flaky = [];
const active = features.filter((f) => f.retired === undefined);
const testFiles = active.flatMap((f) => f.tests).filter((f) => existsSync(path.join(root, f)));
for (const [index, testRun] of planTestRuns(testFiles).entries()) {
  if (testRun.kind === "node-test") {
    for (const file of testRun.files) {
      results.set(file, run(`node-test-${path.basename(file)}`, "node", ["--test", file]).ok);
    }
    continue;
  }
  const name = `vitest-${index}-${path.basename(testRun.cwd)}${testRun.project ? `-${testRun.project}` : ""}`;
  const vitest = (attempt, files) => {
    const jsonPath = path.join(logDir, `${attempt}.json`);
    run(
      attempt,
      "npx",
      [
        "vitest",
        "run",
        ...(testRun.project ? ["--project", testRun.project] : []),
        "--maxWorkers=2",
        // fork-check looks for behavior regressions, not speed. Some upstream tests sit near
        // Vitest's 5s default on macOS and fail whenever the machine is busy.
        "--testTimeout=30000",
        "--reporter=json",
        `--outputFile=${jsonPath}`,
        ...files.map((file) => path.relative(testRun.cwd, file)),
      ],
      { cwd: testRun.cwd },
    );
    return vitestFileResults(readJson(jsonPath), root, files);
  };
  const first = vitest(name, testRun.files);
  const failedFirst = testRun.files.filter((file) => !first.get(file));
  const retry = failedFirst.length > 0 ? vitest(`${name}-retry`, failedFirst) : new Map();
  for (const file of testRun.files) {
    const ok = first.get(file) || retry.get(file) === true;
    if (!first.get(file) && ok) flaky.push(file);
    results.set(file, ok);
  }
}

if (args.e2e) {
  const specs = [...new Set(active.flatMap((f) => f.e2e ?? []))].filter((f) =>
    existsSync(path.join(root, f)),
  );
  if (specs.length > 0) {
    const jsonPath = path.join(logDir, "e2e.json");
    run(
      "e2e",
      "npx",
      [
        "playwright",
        "test",
        "--project=browser",
        "--retries=1",
        "--reporter=json",
        ...specs.map((spec) => path.relative("packages/app", spec)),
      ],
      { cwd: "packages/app", env: { PLAYWRIGHT_JSON_OUTPUT_NAME: jsonPath } },
    );
    const report = readJson(jsonPath);
    for (const [file, ok] of playwrightFileResults(report, "packages/app/e2e/browser", specs)) {
      results.set(file, ok);
    }
  }
}

const verdicts = featureVerdicts(features, results);
const failing = verdicts.filter((v) => v.status === "fail");
const notRun = verdicts.filter((v) => v.status === "not-run");
const staticFailures = staticResults.filter((r) => !r.ok);
const ok = listErrors.length === 0 && staticFailures.length === 0 && failing.length === 0;
const passing = verdicts.filter((v) => v.status === "pass").length;
const head = spawnSync("git", ["log", "-1", "--format=%h %s"], { cwd: root, encoding: "utf8" });

const lines = [
  `## Fork check: ${ok ? "PASS" : "FAIL"}`,
  "",
  `Commit ${head.stdout.trim()}. ${passing} of ${verdicts.length} features pass` +
    `${args.e2e ? " (unit + e2e)" : " (unit only; e2e not run)"}.`,
  "",
];
if (staticResults.length > 0) {
  lines.push(
    `- ${staticResults.map((r) => `${r.name} ${r.ok ? "passed" : `FAILED (${r.logPath})`}`).join(", ")}`,
  );
}
for (const error of listErrors) lines.push(`- Feature list: ${error}`);
for (const verdict of failing) {
  lines.push(`- FAIL #${verdict.pr} ${verdict.title}: ${verdict.failed.join(", ")}`);
}
if (notRun.length > 0) {
  lines.push(`- Not run: ${notRun.map((v) => `#${v.pr}`).join(" ")}`);
}
const untested = verdicts.filter((v) => v.status === "untested").map((v) => `#${v.pr}`);
if (untested.length > 0) lines.push(`- No tests by design: ${untested.join(" ")}`);
if (flaky.length > 0) lines.push(`- Flaky (failed, then passed on rerun): ${flaky.join(", ")}`);
lines.push("", `Logs: ${logDir}`);

const report = `${lines.join("\n")}\n`;
process.stdout.write(report);
if (args.report) writeFileSync(args.report, report);
process.exit(ok ? 0 : 1);
