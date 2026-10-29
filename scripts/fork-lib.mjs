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
 * Problems that make fork-check fail: a guarding test that no longer exists (usually upstream
 * moved or deleted it), a feature with nothing guarding it, or a merged fork PR with no entry.
 */
export function validateFeatures(features, { exists, mergedPrs }) {
  const errors = [];
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
  }
  return errors;
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
 * Per-line owners of a file from `git blame --porcelain`: the fork PR whose commits wrote the
 * line, "sync" for a line written while resolving an earlier upstream merge, null for upstream.
 * `ownerOf(sha)` returns that owner for a commit.
 */
export function parseBlameOwners(porcelain, ownerOf) {
  const lines = [];
  const owners = [];
  let sha = null;
  for (const line of porcelain.split("\n")) {
    const header = /^([0-9a-f]{40}) \d+ \d+/.exec(line);
    if (header) sha = header[1];
    else if (line.startsWith("\t")) {
      lines.push(line.slice(1));
      owners.push(ownerOf(sha));
    }
  }
  return { lines, owners };
}

/** Old-side lines (context and removed) of each hunk in a unified diff of one file. */
export function parseHunks(diff) {
  const hunks = [];
  let current = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) {
      current = [];
      hunks.push(current);
    } else if (current && (line.startsWith(" ") || line.startsWith("-"))) {
      current.push(line.slice(1));
    }
  }
  return hunks;
}

/** Ours-side lines of each conflict block in a file with conflict markers. */
export function conflictBlocks(text) {
  const blocks = [];
  let current = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("<<<<<<<")) current = [];
    else if (current && (line.startsWith("|||||||") || line.startsWith("======="))) {
      blocks.push(current);
      current = null;
    } else if (current) current.push(line);
  }
  return blocks;
}

function locateBlock(lines, block) {
  if (block.length === 0) return -1;
  outer: for (let start = 0; start + block.length <= lines.length; start += 1) {
    for (let offset = 0; offset < block.length; offset += 1) {
      if (lines[start + offset] !== block[offset]) continue outer;
    }
    return start;
  }
  return -1;
}

const lineCounts = new WeakMap();

function uniqueLineIndexes(blame, block) {
  if (!lineCounts.has(blame)) {
    const counts = new Map();
    blame.lines.forEach((line, index) => {
      const seen = counts.get(line);
      counts.set(line, seen === undefined ? index : -1);
    });
    lineCounts.set(blame, counts);
  }
  const counts = lineCounts.get(blame);
  return block.map((line) => counts.get(line) ?? -1).filter((index) => index >= 0);
}

/**
 * Fork owners of the lines in `blame` that each block sits on, plus `margin` lines either side
 * (code next to a fork change usually matters to it). When the fork has edited inside the
 * block, it is found through the block's lines that occur once in the file, spanning the fork
 * lines between them. A block with no such line yields every fork owner in the file.
 */
export function forkOwnersAt(blame, blocks, margin) {
  const found = new Set();
  const addRange = (from, to) => {
    for (const owner of blame.owners.slice(Math.max(0, from), to)) {
      if (owner !== null) found.add(owner);
    }
  };
  for (const block of blocks) {
    const start = locateBlock(blame.lines, block);
    if (start !== -1) {
      addRange(start - margin, start + block.length + margin);
      continue;
    }
    const anchors = uniqueLineIndexes(blame, block);
    if (anchors.length === 0) {
      addRange(0, blame.owners.length);
      continue;
    }
    const first = Math.min(...anchors);
    const last = Math.max(...anchors);
    if (last - first <= block.length + 40) addRange(first - margin, last + margin + 1);
    else for (const anchor of anchors) addRange(anchor - margin, anchor + margin + 1);
  }
  return found;
}

/**
 * Groups `touches` ([{ sha, subject, file, owners }]) by fork owner, most-touched first. This
 * is where upstream replaces or breaks fork work, so it is what a human reads first.
 */
export function riskReport(touches) {
  const byOwner = new Map();
  for (const touch of touches) {
    for (const owner of touch.owners) {
      if (!byOwner.has(owner)) byOwner.set(owner, new Map());
      const commits = byOwner.get(owner);
      if (!commits.has(touch.sha)) {
        commits.set(touch.sha, { sha: touch.sha, subject: touch.subject, files: [] });
      }
      commits.get(touch.sha).files.push(touch.file);
    }
  }
  return [...byOwner.entries()]
    .map(([owner, commits]) => ({ owner, commits: [...commits.values()] }))
    .sort(
      (a, b) =>
        b.commits.length - a.commits.length || String(a.owner).localeCompare(String(b.owner)),
    );
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
