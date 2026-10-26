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
//   --worktree <path>  sync worktree (default: ../paseo-sync next to the main checkout)
//
// Exit codes: 0 up to date or all checks pass, 1 checks fail, 2 merge conflicts.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { conflictOwners, FEATURES_PATH, parseNameStatusLog, riskReport } from "./fork-lib.mjs";

const { values: args } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    resume: { type: "boolean", default: false },
    upstream: { type: "string", default: "upstream/main" },
    base: { type: "string", default: "origin/main" },
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
  const result = spawnSync(command, commandArgs, { cwd, stdio: ["ignore", "inherit", "inherit"] });
  if (result.status !== 0) throw new Error(`${name} failed (exit ${result.status}).`);
}

const commonDir = path.resolve(git(["rev-parse", "--git-common-dir"]).out);
const mainCheckout = path.dirname(commonDir);
const worktree = path.resolve(args.worktree ?? path.join(path.dirname(mainCheckout), "paseo-sync"));
const reportDir = path.join(os.homedir(), ".paseo-fork-sync");
const reportPath = path.join(reportDir, "last-report.md");
mkdirSync(reportDir, { recursive: true });

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

const features = JSON.parse(git(["show", `${base}:${FEATURES_PATH}`], { cwd: worktree }).out);
const commits = parseNameStatusLog(
  git(
    ["log", "--no-merges", "--name-status", "--format=%x00%h%x09%s", `${base}..${args.upstream}`],
    {
      cwd: worktree,
    },
  ).out,
);
const risks = riskReport(features, commits);
const riskLines = [`## Upstream changes touching fork features (${risks.length} features)`, ""];
if (risks.length === 0) riskLines.push("None.");
for (const risk of risks) {
  riskLines.push(`- #${risk.pr} ${risk.title}`);
  for (const c of risk.commits) riskLines.push(`  - ${c.sha} ${c.subject} (${c.files.join(", ")})`);
}
const riskSection = riskLines.join("\n");

if (!args.resume) {
  progress(`merging ${args.upstream} into fork-sync`);
  const merge = git(["merge", "--no-ff", "--no-edit", args.upstream], {
    cwd: worktree,
    allowFail: true,
  });
  if (!merge.ok) {
    const conflicted = git(["diff", "--name-only", "--diff-filter=U"], { cwd: worktree }).out;
    const owners = conflictOwners(features, conflicted.split("\n").filter(Boolean));
    const conflictSection = [
      `## Merge conflicts (${owners.length} files)`,
      "",
      ...owners.map(
        (o) => `- ${o.file}${o.prs.length ? ` (fork ${o.prs.map((n) => `#${n}`).join(" ")})` : ""}`,
      ),
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
