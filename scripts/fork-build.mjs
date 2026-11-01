#!/usr/bin/env node
// Fork-only (Khang5687/paseo); never upstreamed.
// "Build it" in one command, run by the integrator in the main checkout on fork main. See
// "Build it" in CLAUDE.md.
//
//   node scripts/fork-build.mjs --pr 81 --pr 83   sync upstream, merge those PRs in that order,
//                                                 check once, push, then build everything
//   node scripts/fork-build.mjs                   no PRs: sync and build what main has
//   --no-e2e       check without the Playwright specs
//   --no-android   skip the APK
//   --dry-run      say what would happen; merge, push and build nothing (any branch)
//
// 1. Free disk must be at least 8 GB.
// 2. Pull origin/main. Merge upstream through `fork-sync --no-check` unless main already
//    contains upstream/main (the nightly schedule usually applied it). On sync conflicts the
//    build goes on without the sync.
// 3. Merge each PR with `git merge --no-ff origin/<branch> -m "Merge #N: <title>"`. Drafts, closed
//    PRs and conflicting ones are skipped and listed.
// 4. fork-prepare (install/build only what changed), then ONE fork-check (e2e included) on the
//    merged result. Main is pushed only when it passes; when it fails nothing is pushed and the
//    merges stay on local main for inspection.
// 5. Desktop build (fork-update.sh --build-only), remote daemon builds and the APK
//    (fork-android-apk.mjs) at the same time; the APK waits for the desktop build when the disk
//    cannot hold both. Nothing is installed and no daemon is restarted.
//
// Logs and the summary go to ~/.paseo-fork-build/<time>/. Exit codes: 0 pushed and every build
// passed, 1 something failed (see the summary), 4 not enough disk.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  ANDROID_MIN_FREE_GB,
  createTimer,
  formatSeconds,
  freeGb,
  gitRoot,
  MIN_FREE_GB,
  planBuilds,
} from "./fork-build-lib.mjs";

const { values: args } = parseArgs({
  options: {
    pr: { type: "string", multiple: true, default: [] },
    "no-e2e": { type: "boolean", default: false },
    "no-android": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
});
const dryRun = args["dry-run"];
const prs = args.pr.map(Number);

const log = (message) => process.stderr.write(`[fork-build] ${message}\n`);
const root = gitRoot();
const timer = createTimer(log);
const stamp = new Date()
  .toISOString()
  .replace(/\.\d+Z$/, "Z")
  .replaceAll(":", "");
const logDir = path.join(os.homedir(), ".paseo-fork-build", stamp);
mkdirSync(logDir, { recursive: true });

const summary = [];
function finish(code) {
  const text = [
    `# Fork build ${stamp}${dryRun ? " (dry run)" : ""}`,
    "",
    ...summary,
    "",
    "## Timing",
    "",
    timer.table(),
    "",
    `Logs: ${logDir}`,
  ].join("\n");
  writeFileSync(path.join(logDir, "summary.md"), `${text}\n`);
  process.stdout.write(`${text}\n`);
  process.exit(code);
}

function git(gitArgs, { allowFail = false } = {}) {
  const result = spawnSync("git", gitArgs, { cwd: root, encoding: "utf8" });
  if (result.status !== 0 && !allowFail) {
    summary.push(`- git ${gitArgs.join(" ")} failed: ${result.stderr.trim()}`);
    finish(1);
  }
  return { ok: result.status === 0, out: result.stdout.trim(), err: result.stderr.trim() };
}

// Runs a step in the foreground; its output goes to stderr so the integrator sees progress.
function step(name, command, commandArgs) {
  log(`${name}: ${command} ${commandArgs.join(" ")}`);
  return timer.run(name, () =>
    spawnSync(command, commandArgs, { cwd: root, stdio: ["ignore", 2, 2] }),
  ).status;
}

// 1. Disk.
const free = freeGb();
summary.push(`- Disk: ${free.toFixed(1)} GB free at start.`);
if (free < MIN_FREE_GB) {
  summary.push(`- Stopped: below ${MIN_FREE_GB} GB. Ask the owner to free space.`);
  finish(4);
}

// 2. Main and upstream.
const branch = git(["branch", "--show-current"]).out;
const dirty = git(["status", "--porcelain"]).out;
if (branch !== "main" || dirty) {
  const problem = branch !== "main" ? `on ${branch}, not main` : "uncommitted changes";
  if (!dryRun) {
    summary.push(`- Stopped: the checkout is ${problem}.`);
    finish(1);
  }
  summary.push(`- Checkout is ${problem} (dry run continues).`);
}
timer.run("fetch", () => {
  git(["fetch", "--quiet", "origin"]);
  git(["fetch", "--quiet", "upstream"]);
});
if (!dryRun) git(["merge", "--quiet", "--ff-only", "origin/main"]);
if (!dryRun && git(["rev-parse", "HEAD"]).out !== git(["rev-parse", "origin/main"]).out) {
  summary.push(
    "- Stopped: local main has commits that are not on origin/main (a failed earlier run?)." +
      " Look at them, then `git reset --hard origin/main` and rerun.",
  );
  finish(1);
}
const startSha = git(["rev-parse", "--short", "origin/main"]).out;

let synced = false;
const incoming = Number(git(["rev-list", "--count", "origin/main..upstream/main"]).out);
if (incoming === 0) {
  timer.record("upstream sync", 0, "skipped: main already contains upstream/main");
  summary.push(`- Upstream: main ${startSha} already contains upstream/main.`);
} else if (dryRun) {
  timer.record("upstream sync", 0, `would merge ${incoming} commit(s)`);
  summary.push(`- Upstream: ${incoming} commit(s) to merge through fork-sync --no-check.`);
} else {
  const syncLog = path.join(logDir, "fork-sync.md");
  log(`upstream sync: node scripts/fork-sync.mjs --no-check (report ${syncLog})`);
  const out = openSync(syncLog, "w");
  const status = timer.run("upstream sync", () =>
    spawnSync("node", ["scripts/fork-sync.mjs", "--no-check"], {
      cwd: root,
      stdio: ["ignore", out, 2],
    }),
  ).status;
  closeSync(out);
  if (status === 0) {
    git(["merge", "--quiet", "--ff-only", "fork-sync"]);
    synced = true;
    summary.push(`- Upstream: merged ${incoming} commit(s) cleanly (report ${syncLog}).`);
  } else if (status === 2) {
    summary.push(
      `- Upstream: NOT synced, the merge conflicts (report ${syncLog}). Building without it;` +
        " resolve with `node scripts/fork-sync.mjs --apply` later.",
    );
  } else {
    summary.push(
      `- Stopped: fork-sync exited ${status}${status === 3 ? " (another fork-sync is running; rerun when it ends)" : ""}. Report ${syncLog}.`,
    );
    finish(1);
  }
}

// 3. PRs.
const originUrl = git(["remote", "get-url", "origin"]).out;
const repo = /github\.com[:/](.+?)(\.git)?$/.exec(originUrl)?.[1];
const merged = [];
const skipped = [];
let last = synced ? "the upstream sync" : null;
for (const pr of prs) {
  const view = spawnSync(
    "gh",
    [
      "pr",
      "view",
      String(pr),
      "--repo",
      repo,
      "--json",
      "title,headRefName,baseRefName,isDraft,state,mergeable",
    ],
    { cwd: root, encoding: "utf8" },
  );
  if (view.status !== 0) {
    skipped.push(`#${pr}: gh pr view failed: ${view.stderr.trim()}`);
    continue;
  }
  const info = JSON.parse(view.stdout);
  let reason = null;
  if (info.state !== "OPEN") reason = info.state.toLowerCase();
  else if (info.isDraft) reason = "draft";
  else if (info.baseRefName !== "main") reason = `targets ${info.baseRefName}, not main`;
  else if (info.mergeable === "CONFLICTING") reason = "GitHub reports CONFLICTING";
  if (reason) {
    skipped.push(`#${pr} ${info.headRefName}: ${reason}`);
    continue;
  }
  const ref = `origin/${info.headRefName}`;
  if (dryRun) {
    // Each PR alone against origin/main; the real run merges them one after another.
    const probe = git(["merge-tree", "--write-tree", "--quiet", "origin/main", ref], {
      allowFail: true,
    });
    if (probe.ok) merged.push(`#${pr} ${info.title} (would merge ${ref})`);
    else skipped.push(`#${pr} ${info.headRefName}: conflicts with main as it is now`);
    continue;
  }
  const merge = timer.run(`merge #${pr}`, () =>
    git(["merge", "--quiet", "--no-ff", ref, "-m", `Merge #${pr}: ${info.title}`], {
      allowFail: true,
    }),
  );
  if (!merge.ok) {
    git(["merge", "--abort"], { allowFail: true });
    skipped.push(`#${pr} ${info.headRefName}: conflicts with main${last ? ` after ${last}` : ""}`);
    continue;
  }
  merged.push(`#${pr} ${info.title}`);
  last = `#${pr}`;
}
if (merged.length > 0) summary.push(`- Merged: ${merged.join("; ")}.`);
for (const line of skipped) summary.push(`- Skipped ${line}.`);

// 4. One check, then push.
const changed = synced || last !== null;
const checkReport = path.join(logDir, "fork-check.md");
if (dryRun) {
  step("prepare", "node", ["scripts/fork-prepare.mjs", "--dry-run"]);
  timer.record("fork-check", 0, `would run${args["no-e2e"] ? " (no e2e)" : " with e2e"}`);
} else if (!changed) {
  timer.record("fork-check", 0, "skipped: main unchanged since it was pushed");
  summary.push(
    `- Check: skipped, nothing merged; main ${startSha} was checked when it was pushed.`,
  );
} else {
  if (step("prepare", "node", ["scripts/fork-prepare.mjs"]) !== 0) {
    summary.push("- Stopped: fork-prepare failed (see above). Nothing pushed.");
    finish(1);
  }
  const checkArgs = ["scripts/fork-check.mjs", "--report", checkReport];
  if (!args["no-e2e"]) checkArgs.push("--e2e");
  const status = step("fork-check", "node", checkArgs);
  const report = existsSync(checkReport)
    ? readFileSync(checkReport, "utf8").trim()
    : `fork-check crashed (exit ${status}).`;
  summary.push("", report, "");
  if (status !== 0) {
    summary.push(
      "- Stopped: the check failed, so nothing was pushed. Local main still has the merges." +
        " Find the PR that broke it, `git reset --hard origin/main`, and rerun without it" +
        " (set its handoff entry to blocked).",
    );
    finish(1);
  }
  const push = timer.run("push", () =>
    git(["push", "--quiet", "origin", "main"], { allowFail: true }),
  );
  if (!push.ok) {
    summary.push(`- Stopped: push to origin main refused (main moved?): ${push.err}`);
    finish(1);
  }
}
const headSha = git(["rev-parse", "--short", "HEAD"]).out;
if (changed && !dryRun) summary.push(`- Pushed: origin main is now ${headSha}.`);

// 5. Builds.
const plan = planBuilds({ freeGb: freeGb(), android: !args["no-android"] });
if (plan.stop) {
  summary.push(`- Builds not started: ${plan.stop}`);
  finish(4);
}
const remotesFile = path.join(os.homedir(), ".paseo-fork-remotes");
const hosts = existsSync(remotesFile)
  ? readFileSync(remotesFile, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
  : [];
const androidPlan = {
  skip: "skipped (--no-android)",
  parallel: "beside the desktop build",
  "after-desktop": `after the desktop build (the disk cannot hold both; that needs ${MIN_FREE_GB + ANDROID_MIN_FREE_GB} GB)`,
  "no-disk": `NOT built: it needs ${ANDROID_MIN_FREE_GB} GB free; run \`node scripts/fork-android-apk.mjs\` after freeing space`,
}[plan.android];
summary.push(
  `- Builds: desktop, ${hosts.length > 0 ? `remote ${hosts.join(", ")}` : "no remote hosts"}; APK ${androidPlan}.`,
);
if (dryRun) {
  step("android (dry run)", "node", ["scripts/fork-android-apk.mjs", "--dry-run"]);
  finish(0);
}

const started = Date.now();
function build(name, command, commandArgs) {
  const logPath = path.join(logDir, `${name.replaceAll(" ", "-")}.log`);
  const out = openSync(logPath, "w");
  const t = Date.now();
  log(`${name}: started (log ${logPath})`);
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, { cwd: root, stdio: ["ignore", out, out] });
    child.on("close", (code) => {
      closeSync(out);
      const seconds = (Date.now() - t) / 1000;
      const note = `${code === 0 ? "ok" : `FAILED (exit ${code})`}, started at +${formatSeconds((t - started) / 1000)}`;
      timer.record(name, seconds, note);
      resolve({ name, ok: code === 0, code, logPath });
    });
  });
}

const desktop = build("desktop", "scripts/fork-update.sh", ["--build-only"]);
const jobs = [
  desktop,
  ...hosts.map((host) => build(`remote ${host}`, "scripts/fork-remote-daemon.sh", [host, "build"])),
];
const apk = () => build("android", "node", ["scripts/fork-android-apk.mjs"]);
if (plan.android === "parallel") jobs.push(apk());
if (plan.android === "after-desktop") jobs.push(desktop.then(apk));
const results = await Promise.all(jobs);

for (const result of results) {
  let detail = result.ok ? "ok" : "FAILED";
  if (result.name === "android" && result.code === 4) {
    detail = `not enough disk (needs ${ANDROID_MIN_FREE_GB} GB free); run \`node scripts/fork-android-apk.mjs\` after freeing space`;
  }
  summary.push(`  - ${result.name}: ${detail} (log ${result.logPath})`);
}
summary.push(
  "",
  `Next: update ~/git/paseo-HANDOFF.md, restart each remote host with \`scripts/fork-remote-daemon.sh <host> restart\`` +
    " (refuses while agents work), and give the owner the install steps.",
);
finish(results.every((result) => result.ok) && plan.android !== "no-disk" ? 0 : 1);
