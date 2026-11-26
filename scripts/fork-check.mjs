#!/usr/bin/env node
// Fork-only (Khang5687/paseo); never upstreamed.
// Runs typecheck, lint, and every test listed in scripts/fork-features/<N>.json, then reports
// which fork PRs pass. See "Fork features and fork-check" in CLAUDE.md.
//
//   node scripts/fork-check.mjs                  typecheck + lint + unit tests
//   node scripts/fork-check.mjs --e2e            also the Playwright specs (starts Metro + daemon),
//                                                beside the static and unit steps
//   node scripts/fork-check.mjs --e2e --bail     run the specs after, and only if, those pass
//   node scripts/fork-check.mjs --e2e-workers 2  Playwright workers (default: from free memory;
//                                                E2E_WORKERS works too)
//   node scripts/fork-check.mjs --pr 55 --pr 58  only those features' tests
//   node scripts/fork-check.mjs --no-static      skip typecheck and lint
//   node scripts/fork-check.mjs --report <file>  also write the Markdown report there
//
// Workspace declarations must be built first (npm run build:server && npm run build:plugin).
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  featureVerdicts,
  loadFeatures,
  memAvailableGb,
  mergedForkPrs,
  pickE2eWorkers,
  planTestRuns,
  playwrightFileResults,
  validateFeatures,
  vitestFileResults,
} from "./fork-lib.mjs";

const { values: args } = parseArgs({
  options: {
    e2e: { type: "boolean", default: false },
    "e2e-workers": { type: "string" },
    "no-static": { type: "boolean", default: false },
    bail: { type: "boolean", default: false },
    pr: { type: "string", multiple: true, default: [] },
    report: { type: "string" },
  },
});

const root = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout.trim();
const logDir = path.join(os.tmpdir(), `fork-check-${Date.now()}`);
mkdirSync(logDir, { recursive: true });
const progress = (message) => process.stderr.write(`[fork-check] ${message}\n`);

// Test terminals run the user's real rc files. A .bashrc that attaches to tmux when it sees an
// SSH session (common on a build host) would put every test terminal into the user's live tmux
// session and type the tests' input there, so the checks never see an SSH session.
const SSH_SESSION_VARS = new Set(["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"]);
const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !SSH_SESSION_VARS.has(key)),
);

// Output goes straight to the log file, so a long step (the e2e run) can be followed with tail -f.
// Async so the e2e step can run beside the static and unit steps.
function run(name, command, commandArgs, { cwd = ".", env = {} } = {}) {
  const logPath = path.join(logDir, `${name}.log`);
  const started = Date.now();
  progress(`${name}: ${command} ${commandArgs.join(" ").slice(0, 160)}`);
  const log = openSync(logPath, "w");
  const child = spawn(command, commandArgs, {
    cwd: path.join(root, cwd),
    env: { ...baseEnv, ...env },
    stdio: ["ignore", log, log],
  });
  closeSync(log);
  return new Promise((resolve) => {
    const finish = (status) => {
      const seconds = Math.round((Date.now() - started) / 1000);
      progress(`${name}: exit ${status} in ${seconds}s (log ${logPath})`);
      resolve({ ok: status === 0, logPath });
    };
    child.once("error", () => finish("error"));
    child.once("close", finish);
  });
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
const results = new Map();
// Files that failed, then passed when rerun alone. A nightly run shares the machine with
// whatever else is going on, and timing-sensitive tests fail under load.
const flaky = [];
const active = features.filter((f) => f.retired === undefined);
const testFiles = active.flatMap((f) => f.tests).filter((f) => existsSync(path.join(root, f)));

async function staticStep() {
  if (args["no-static"]) return;
  staticResults.push({
    name: "typecheck",
    ...(await run("typecheck", "npm", ["run", "typecheck"])),
  });
  staticResults.push({ name: "lint", ...(await run("lint", "npm", ["run", "lint"])) });
}

// The unit tests, one package at a time.
async function unitStep() {
  for (const [index, testRun] of planTestRuns(testFiles).entries()) {
    if (testRun.kind === "node-test") {
      for (const file of testRun.files) {
        results.set(
          file,
          (await run(`node-test-${path.basename(file)}`, "node", ["--test", file])).ok,
        );
      }
      continue;
    }
    const name = `vitest-${index}-${path.basename(testRun.cwd)}${testRun.project ? `-${testRun.project}` : ""}`;
    const vitest = async (attempt, files) => {
      const jsonPath = path.join(logDir, `${attempt}.json`);
      await run(
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
    const first = await vitest(name, testRun.files);
    const failedFirst = testRun.files.filter((file) => !first.get(file));
    const retry = failedFirst.length > 0 ? await vitest(`${name}-retry`, failedFirst) : new Map();
    for (const file of testRun.files) {
      const ok = first.get(file) || retry.get(file) === true;
      if (!first.get(file) && ok) flaky.push(file);
      results.set(file, ok);
    }
  }
}

// The unit tests may still be running when the e2e step starts (see below), so leave them
// room. Measured on the Omen: with 3 workers the run itself took about 10 GB, and
// MemAvailable should stay above 5 GB so earlyoom has nothing to kill. Other agents' builds
// and emulators take memory too, which is why the reserve is generous.
const PARALLEL_RESERVE_GB = 5;

// `--e2e-workers` or E2E_WORKERS wins; otherwise free memory decides. Without /proc/meminfo
// (macOS) that is one worker, as before.
function chooseE2eWorkers(reserveGb) {
  const forced = args["e2e-workers"] ?? process.env.E2E_WORKERS;
  if (forced !== undefined) {
    const workers = Number(forced);
    if (!Number.isInteger(workers) || workers < 1) {
      throw new Error(`e2e workers must be a positive integer, got "${forced}"`);
    }
    return { workers, why: "override" };
  }
  let availableGb = null;
  try {
    availableGb = memAvailableGb(readFileSync("/proc/meminfo", "utf8"));
  } catch {}
  if (availableGb === null) return { workers: 1, why: "free memory unknown" };
  const workers = pickE2eWorkers(availableGb, reserveGb);
  const reserved = reserveGb > 0 ? `, ${reserveGb} GB kept for the unit steps` : "";
  return { workers, why: `${availableGb.toFixed(1)} GB available${reserved}` };
}

async function e2eStep({ reserveGb }) {
  const specs = [...new Set(active.flatMap((f) => f.e2e ?? []))].filter((f) =>
    existsSync(path.join(root, f)),
  );
  // The browser binary lives outside node_modules (~/.cache/ms-playwright) and npm ci does not
  // fetch it; without it every spec fails at launch. A no-op when this version is installed.
  const browser =
    specs.length > 0
      ? await run("playwright-install", "npx", ["playwright", "install", "chromium"], {
          cwd: "packages/app",
        })
      : { ok: true };
  if (!browser.ok) {
    progress("e2e: not run (playwright install chromium failed); every spec counts as failed");
    for (const spec of specs) results.set(spec, false);
    return;
  }
  if (specs.length === 0) return;
  const { workers, why } = chooseE2eWorkers(reserveGb);
  progress(`e2e: ${workers} Playwright worker${workers === 1 ? "" : "s"} (${why})`);
  const jsonPath = path.join(logDir, "e2e.json");
  await run(
    "e2e",
    "npx",
    [
      "playwright",
      "test",
      "--project=browser",
      "--retries=1",
      // list streams each spec to the log as it finishes; json is what the verdicts read.
      "--reporter=list,json",
      ...specs.map((spec) => path.relative("packages/app", spec)),
    ],
    {
      cwd: "packages/app",
      env: { PLAYWRIGHT_JSON_OUTPUT_NAME: jsonPath, E2E_WORKERS: String(workers) },
    },
  );
  const report = readJson(jsonPath);
  for (const [file, ok] of playwrightFileResults(report, "packages/app/e2e/browser", specs)) {
    results.set(file, ok);
  }
}

// The e2e step is the long one and starts its own Metro and daemon, so it runs beside the unit
// tests. It waits for typecheck and lint: Metro's first bundle compile is CPU-bound, and under
// a busy machine it ran past its 2 minute warmup while typecheck was still going. --bail keeps
// the old order: e2e only after everything else passes.
let e2eSkipped = false;
await staticStep();
if (args.e2e && !args.bail) {
  await Promise.all([unitStep(), e2eStep({ reserveGb: PARALLEL_RESERVE_GB })]);
} else {
  await unitStep();
  if (args.e2e) {
    const failedBeforeE2e =
      listErrors.length > 0 ||
      staticResults.some((r) => !r.ok) ||
      [...results.values()].some((ok) => !ok);
    if (failedBeforeE2e) {
      e2eSkipped = true;
      progress("e2e: skipped (--bail; static or unit checks already failed)");
    } else {
      await e2eStep({ reserveGb: 0 });
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
let scope = " (unit only; e2e not run)";
if (e2eSkipped) scope = " (unit only; e2e skipped after a failure)";
else if (args.e2e) scope = " (unit + e2e)";

const lines = [
  `## Fork check: ${ok ? "PASS" : "FAIL"}`,
  "",
  `Commit ${head.stdout.trim()}. ${passing} of ${verdicts.length} features pass${scope}.`,
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
