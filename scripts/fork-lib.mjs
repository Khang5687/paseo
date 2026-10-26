// Fork-only (Khang5687/paseo); never upstreamed.
// Pure logic shared by scripts/fork-check.mjs and scripts/fork-sync.mjs: reading the fork
// feature list, mapping test results and upstream changes back to fork PRs.
import { readFileSync } from "node:fs";
import path from "node:path";

export const FEATURES_PATH = "scripts/fork-features.json";

export function loadFeatures(root) {
  return JSON.parse(readFileSync(path.join(root, FEATURES_PATH), "utf8"));
}

function activeFeatures(features) {
  return features.filter((feature) => feature.retired === undefined);
}

/**
 * Errors make fork-check fail: a guarding test that no longer exists (usually upstream moved
 * or deleted it), a feature with nothing guarding it, or a merged fork PR with no entry.
 * Missing owned files are only warnings: the list goes stale when upstream moves code, and
 * the risk report is the only thing that reads it.
 */
export function validateFeatures(features, { exists, mergedPrs }) {
  const errors = [];
  const warnings = [];
  const listed = new Set(features.map((feature) => feature.pr));
  for (const pr of mergedPrs) {
    if (!listed.has(pr)) {
      errors.push(`#${pr} is merged on main but has no entry in ${FEATURES_PATH}.`);
    }
  }
  for (const feature of activeFeatures(features)) {
    const guards = [...feature.tests, ...(feature.e2e ?? [])];
    if (guards.length === 0 && feature.untested === undefined) {
      errors.push(`#${feature.pr} lists no tests and no "untested" reason.`);
    }
    for (const file of guards) {
      if (!exists(file)) {
        errors.push(`#${feature.pr}: test ${file} no longer exists (moved or deleted upstream?).`);
      }
    }
    for (const file of feature.files) {
      if (!exists(file)) warnings.push(`#${feature.pr}: owned file ${file} no longer exists.`);
    }
  }
  return { errors, warnings };
}

/**
 * Groups test files into the runs fork-check makes: one Vitest run per workspace package
 * (`packages/<name>`, and `plugins`, which is one package), app browser tests through the
 * browser project, root scripts through node --test.
 */
export function planTestRuns(files) {
  const runs = new Map();
  const add = (key, init, file) => {
    if (!runs.has(key)) runs.set(key, { ...init, files: [] });
    runs.get(key).files.push(file);
  };
  for (const file of [...new Set(files)].sort()) {
    const cwd = /^(packages\/[^/]+|plugins)\//.exec(file)?.[1];
    if (cwd === undefined) {
      add("node-test", { kind: "node-test", cwd: "." }, file);
    } else if (cwd === "packages/app" && /\.browser\.(test|spec)\.tsx?$/.test(file)) {
      add("app-browser", { kind: "vitest", cwd, project: "browser" }, file);
    } else {
      add(cwd, { kind: "vitest", cwd, project: cwd === "packages/app" ? "unit" : undefined }, file);
    }
  }
  return [...runs.values()];
}

/** Per-file status from a Vitest JSON report; files absent from the report count as failed. */
export function vitestFileResults(report, root, files) {
  const byFile = new Map();
  for (const result of report?.testResults ?? []) {
    byFile.set(path.relative(root, result.name), result.status === "passed");
  }
  return new Map(files.map((file) => [file, byFile.get(file) ?? false]));
}

/** Per-file status from a Playwright JSON report; a file passes only if every test in it passed. */
export function playwrightFileResults(report, testDir, files) {
  const okByFile = new Map();
  const visit = (suite, file) => {
    const suiteFile = suite.file ?? file;
    for (const spec of suite.specs ?? []) {
      okByFile.set(suiteFile, (okByFile.get(suiteFile) ?? true) && spec.ok);
    }
    for (const child of suite.suites ?? []) visit(child, suiteFile);
  };
  for (const suite of report?.suites ?? []) visit(suite, suite.file);
  return new Map(files.map((file) => [file, okByFile.get(path.relative(testDir, file)) ?? false]));
}

/** Feature verdicts from per-file results. A feature with no file in `results` was not run. */
export function featureVerdicts(features, results) {
  return activeFeatures(features).map((feature) => {
    const guards = [...feature.tests, ...(feature.e2e ?? [])];
    const ran = guards.filter((file) => results.has(file));
    const failed = ran.filter((file) => !results.get(file));
    let status = "pass";
    if (ran.length === 0) status = feature.untested === undefined ? "not-run" : "untested";
    else if (failed.length > 0) status = "fail";
    return { pr: feature.pr, title: feature.title, status, failed };
  });
}

/**
 * Which upstream commits touch files a fork feature owns or tests. These are where upstream
 * replaces or breaks fork work, so they are what a human reads first after a sync.
 * `commits` is [{ sha, subject, changes: [{ status, file }] }].
 */
export function riskReport(features, commits) {
  const owners = new Map();
  for (const feature of activeFeatures(features)) {
    for (const file of [...feature.files, ...feature.tests, ...(feature.e2e ?? [])]) {
      if (!owners.has(file)) owners.set(file, []);
      owners.get(file).push(feature);
    }
  }
  const byPr = new Map();
  for (const commit of commits) {
    for (const { status, file } of commit.changes) {
      for (const feature of owners.get(file) ?? []) {
        if (!byPr.has(feature.pr)) byPr.set(feature.pr, { feature, commits: new Map() });
        const entry = byPr.get(feature.pr).commits;
        if (!entry.has(commit.sha)) entry.set(commit.sha, { ...commit, files: [] });
        entry.get(commit.sha).files.push(status === "D" ? `${file} (deleted)` : file);
      }
    }
  }
  return [...byPr.values()]
    .map(({ feature, commits: touching }) => ({
      pr: feature.pr,
      title: feature.title,
      commits: [...touching.values()].map(({ sha, subject, files }) => ({ sha, subject, files })),
    }))
    .sort((a, b) => b.commits.length - a.commits.length || a.pr - b.pr);
}

/** Fork features owning each conflicted file, for a conflict report. */
export function conflictOwners(features, conflictedFiles) {
  return conflictedFiles.map((file) => ({
    file,
    prs: activeFeatures(features)
      .filter((feature) => feature.files.includes(file) || feature.tests.includes(file))
      .map((feature) => feature.pr),
  }));
}

/** Parses `git log --name-status --format=%x00%h%x09%s` output. */
export function parseNameStatusLog(text) {
  return text
    .split("\0")
    .filter((chunk) => chunk.trim().length > 0)
    .map((chunk) => {
      const [header, ...lines] = chunk.split("\n");
      const [sha, ...subject] = header.split("\t");
      const changes = lines
        .filter((line) => line.length > 0)
        .flatMap((line) => {
          const [status, ...paths] = line.split("\t");
          // Renames list old and new path; both belong to whoever owned the old one.
          return paths.map((file) => ({ status: status[0], file }));
        });
      return { sha, subject: subject.join("\t"), changes };
    });
}

/** Fork PR numbers from `git log --first-parent --merges --format=%s` output. */
export function mergedForkPrs(subjects) {
  return subjects
    .split("\n")
    .map((subject) => /^Merge #(\d+): /.exec(subject))
    .filter(Boolean)
    .map((match) => Number(match[1]));
}
