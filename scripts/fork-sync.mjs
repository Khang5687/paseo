#!/usr/bin/env node
// Fork-only (Khang5687/paseo); never upstreamed.
// Practice-merges upstream into fork main in a dedicated worktree (never in the main
// checkout), reports which fork features the incoming upstream commits touch, and runs
// fork-check on the result. Fork main moves only with --apply, and only when every check
// passes. See "Syncing with upstream" in CLAUDE.md.
//
//   node scripts/fork-sync.mjs                    rehearse: merge, report, check; never pushes
//   node scripts/fork-sync.mjs --apply            same, then push the merge to origin main
//   node scripts/fork-sync.mjs --apply --resume   after resolving conflicts in the sync
//                                                 worktree and committing: check, then push
//   --upstream <ref>   merge this instead of upstream/main (proving the tool on a crafted ref)
//   --base <ref>       start from this instead of origin/main (rehearsal only; testing changes
//                      to the fork tooling itself before they reach main)
//   --no-e2e           skip the Playwright specs
//   --worktree <path>  sync worktree (default: ../paseo-sync next to the main checkout)
//
// Exit codes: 0 up to date or all checks pass, 1 checks fail, 2 merge conflicts,
// 3 another fork-sync is running.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  conflictBlocks,
  forkOwnersAt,
  parseBlameOwners,
  parseHunks,
  parseNameStatusLog,
  riskReport,
} from "./fork-lib.mjs";

const { values: args } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    resume: { type: "boolean", default: false },
    upstream: { type: "string", default: "upstream/main" },
    base: { type: "string", default: "origin/main" },
    "no-e2e": { type: "boolean", default: false },
    worktree: { type: "string" },
  },
});

const progress = (message) => process.stderr.write(`[fork-sync] ${message}\n`);

function git(gitArgs, { cwd, allowFail = false } = {}) {
  const result = spawnSync("git", gitArgs, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0 && !allowFail) {
    throw new Error(`git ${gitArgs.join(" ")} failed:\n${result.stderr}`);
  }
  return { ok: result.status === 0, out: result.stdout.trim(), err: result.stderr.trim() };
}

function step(name, command, commandArgs, cwd) {
  progress(`${name}: ${command} ${commandArgs.join(" ")}`);
  // Build output goes to stderr so stdout carries only the report.
  const result = spawnSync(command, commandArgs, { cwd, stdio: ["ignore", 2, 2] });
  if (result.status !== 0) throw new Error(`${name} failed (exit ${result.status}).`);
}

const commonDir = path.resolve(git(["rev-parse", "--git-common-dir"]).out);
const mainCheckout = path.dirname(commonDir);
const worktree = path.resolve(args.worktree ?? path.join(path.dirname(mainCheckout), "paseo-sync"));
const reportDir = path.join(os.homedir(), ".paseo-fork-sync");
const reportPath = path.join(reportDir, "last-report.md");
mkdirSync(reportDir, { recursive: true });

// The nightly rehearsal and an integrator's --apply share one worktree; a second run would
// reset it under the first.
const lockPath = path.join(reportDir, "lock");
try {
  writeFileSync(lockPath, String(process.pid), { flag: "wx" });
} catch {
  const holder = Number(readFileSync(lockPath, "utf8"));
  let alive = false;
  try {
    process.kill(holder, 0);
    alive = true;
  } catch {
    // The holder exited without releasing the lock; take it over.
  }
  if (alive) {
    process.stderr.write(`[fork-sync] another fork-sync is running (pid ${holder}); exiting.\n`);
    process.exit(3);
  }
  writeFileSync(lockPath, String(process.pid));
}
process.on("exit", () => unlinkSync(lockPath));

function finish(code, sections) {
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const report = `# Fork sync ${stamp}\n\n${sections.join("\n\n")}\n`;
  writeFileSync(reportPath, report);
  writeFileSync(path.join(reportDir, `report-${stamp.replaceAll(":", "")}.md`), report);
  process.stdout.write(`${report}\nReport saved to ${reportPath}\n`);
  process.exit(code);
}

progress("fetching origin and upstream");
git(["fetch", "--quiet", "origin"], { cwd: mainCheckout });
git(["fetch", "--quiet", "upstream"], { cwd: mainCheckout });
const upstreamSha = git(["rev-parse", "--short", args.upstream], { cwd: mainCheckout }).out;
const base = args.base;
if (args.apply && base !== "origin/main") {
  throw new Error("--apply moves fork main, so it always starts from origin/main; drop --base.");
}

if (!existsSync(worktree)) {
  progress(`creating sync worktree ${worktree}`);
  git(["worktree", "add", "-B", "fork-sync", worktree, base], { cwd: mainCheckout });
}
const merging = existsSync(
  path.join(git(["rev-parse", "--git-dir"], { cwd: worktree }).out, "MERGE_HEAD"),
);

if (args.resume) {
  if (merging) {
    finish(2, ["A merge is still in progress in the sync worktree. Resolve it, commit, rerun."]);
  }
  if (
    !git(["merge-base", "--is-ancestor", args.upstream, "HEAD"], { cwd: worktree, allowFail: true })
      .ok
  ) {
    finish(2, [`${worktree} does not contain ${args.upstream}; nothing to resume.`]);
  }
} else {
  if (merging) {
    finish(2, [
      `A merge is in progress in ${worktree}; someone may be resolving it. Finish it and run` +
        " `node scripts/fork-sync.mjs --apply --resume`, or abort it there (`git merge --abort`).",
    ]);
  }
  git(["checkout", "--quiet", "-B", "fork-sync", base], { cwd: worktree });
  git(["reset", "--quiet", "--hard", base], { cwd: worktree });
  git(["clean", "--quiet", "-fd"], { cwd: worktree });
}

const incoming = Number(
  git(["rev-list", "--count", `${base}..${args.upstream}`], { cwd: worktree }).out,
);
const baseSha = git(["rev-parse", "--short", base], { cwd: worktree }).out;
const header = `Fork main ${baseSha}, ${args.upstream} ${upstreamSha}: ${incoming} upstream commit(s) not on fork main.`;
if (incoming === 0 && !args.resume) finish(0, [header, "Up to date. Nothing to check."]);

// Which fork PR wrote each commit on fork main, so blame can name the fork lines an upstream
// change lands next to. Merges that are not "Merge #N" are earlier upstream syncs; lines
// written while resolving them belong to the fork too.
const ownerBySha = new Map();
const titles = new Map([["sync", "lines written while resolving an earlier upstream merge"]]);
const forkMerges = git(
  ["log", "--first-parent", "--merges", "--format=%H %P%x09%s", base, "--not", args.upstream],
  { cwd: worktree },
).out;
for (const line of forkMerges.split("\n").filter(Boolean)) {
  const [shas, subject] = line.split("\t");
  const [merge, first, second] = shas.split(" ");
  const pr = /^Merge #(\d+): (.*)/.exec(subject);
  if (!pr) {
    ownerBySha.set(merge, "sync");
    continue;
  }
  titles.set(Number(pr[1]), pr[2]);
  ownerBySha.set(merge, Number(pr[1]));
  const branch = git(["rev-list", `${first}..${second}`, "--not", args.upstream], {
    cwd: worktree,
  });
  for (const sha of branch.out.split("\n").filter(Boolean)) ownerBySha.set(sha, Number(pr[1]));
}
const blames = new Map();
function blameOf(file) {
  if (!blames.has(file)) {
    const blame = git(["blame", "--porcelain", base, "--", file], {
      cwd: worktree,
      allowFail: true,
    });
    const parsed = blame.ok
      ? parseBlameOwners(blame.out, (sha) => ownerBySha.get(sha) ?? null)
      : null;
    blames.set(file, parsed?.owners.some((owner) => owner !== null) ? parsed : null);
  }
  return blames.get(file);
}
const ownerLabel = (owner) =>
  owner === "sync" ? titles.get(owner) : `#${owner} ${titles.get(owner)}`;

progress(`attributing ${incoming} upstream commit(s) to fork lines`);
const touches = [];
const commits = parseNameStatusLog(
  git(
    ["log", "--no-merges", "--name-status", "--format=%x00%h%x09%s", `${base}..${args.upstream}`],
    {
      cwd: worktree,
    },
  ).out,
);
for (const commit of commits) {
  for (const { status, file } of commit.changes) {
    const blame = status === "A" ? null : blameOf(file);
    if (!blame) continue;
    // A deleted or renamed file takes every fork line in it along; [[]] matches nowhere.
    const blocks =
      status === "M"
        ? parseHunks(
            git(["show", "--format=", "-U3", commit.sha, "--", file], { cwd: worktree }).out,
          )
        : [[]];
    const owners = forkOwnersAt(blame, blocks, 3);
    if (owners.size === 0) continue;
    const suffix = { D: " (deleted)", R: " (renamed)" }[status] ?? "";
    const label = `${file}${suffix}`;
    touches.push({ sha: commit.sha, subject: commit.subject, file: label, owners });
  }
}
const risks = riskReport(touches);
const riskLines = [
  `## Upstream changes next to fork code (${risks.length} fork PRs)`,
  "",
  "Upstream commits that change lines within 3 lines of code a fork PR wrote.",
  "",
];
if (risks.length === 0) riskLines.push("None.");
for (const risk of risks) {
  riskLines.push(`- ${ownerLabel(risk.owner)}`);
  for (const c of risk.commits) riskLines.push(`  - ${c.sha} ${c.subject} (${c.files.join(", ")})`);
}
const riskSection = riskLines.join("\n");

if (!args.resume) {
  progress(`merging ${args.upstream} into fork-sync`);
  // The commit lands on fork main, so it should not name the worktree's branch.
  const message = `Merge ${args.upstream} ${upstreamSha} into fork main`;
  const merge = git(["merge", "--no-ff", "-m", message, args.upstream], {
    cwd: worktree,
    allowFail: true,
  });
  if (!merge.ok) {
    const conflicted = git(["diff", "--name-only", "--diff-filter=U"], { cwd: worktree }).out;
    const conflictLines = [];
    for (const file of conflicted.split("\n").filter(Boolean)) {
      const blame = blameOf(file);
      const text = readFileSync(path.join(worktree, file), "utf8");
      const owners = blame ? [...forkOwnersAt(blame, conflictBlocks(text), 0)] : [];
      conflictLines.push(
        `- ${file}`,
        ...owners.map((owner) => `  - fork side: ${ownerLabel(owner)}`),
      );
    }
    const conflictSection = [
      `## Merge conflicts (${conflicted.split("\n").filter(Boolean).length} files)`,
      "",
      ...conflictLines,
      "",
      args.apply
        ? `The merge is left in progress in ${worktree}. Resolve there, commit, then run` +
          " `node scripts/fork-sync.mjs --apply --resume`."
        : "Rehearsal only, so the merge was aborted. Resolve them with `--apply`.",
    ].join("\n");
    if (!args.apply) git(["merge", "--abort"], { cwd: worktree });
    finish(2, [header, conflictSection, riskSection]);
  }
}

try {
  const lockHash = createHash("sha256")
    .update(readFileSync(path.join(worktree, "package-lock.json")))
    .digest("hex");
  const stampPath = path.join(worktree, "node_modules", ".fork-sync-lock-hash");
  const installed = existsSync(stampPath) ? readFileSync(stampPath, "utf8") : "";
  if (installed !== lockHash) {
    step("npm ci", "npm", ["ci", "--no-audit", "--no-fund"], worktree);
    writeFileSync(stampPath, lockHash);
  }
  step("build:server", "npm", ["run", "build:server"], worktree);
  step("build:plugin", "npm", ["run", "build:plugin"], worktree);
} catch (error) {
  finish(1, [header, `## Build failed\n\n${error.message}`, riskSection]);
}

const checkReport = path.join(reportDir, "fork-check.md");
const check = spawnSync(
  "node",
  ["scripts/fork-check.mjs", ...(args["no-e2e"] ? [] : ["--e2e"]), "--report", checkReport],
  { cwd: worktree, stdio: ["ignore", "ignore", "inherit"] },
);
const checkSection = existsSync(checkReport)
  ? readFileSync(checkReport, "utf8").trim()
  : `fork-check crashed (exit ${check.status}).`;

if (check.status !== 0) {
  finish(1, [
    header,
    checkSection,
    riskSection,
    `Fork main was not changed. The merge is in ${worktree}.`,
  ]);
}
if (!args.apply) {
  finish(0, [header, checkSection, riskSection, "Rehearsal only; fork main was not changed."]);
}
// A plain push is fast-forward only, so it refuses if fork main moved during the run.
const push = git(["push", "--quiet", "origin", "HEAD:main"], { cwd: worktree, allowFail: true });
if (!push.ok) {
  finish(1, [header, checkSection, riskSection, `Push to origin main refused:\n\n${push.err}`]);
}
const merged = git(["rev-parse", "--short", "HEAD"], { cwd: worktree }).out;
finish(0, [
  header,
  checkSection,
  riskSection,
  `Fork main is now ${merged}. In the main checkout: \`git pull --ff-only origin main\`.`,
]);
