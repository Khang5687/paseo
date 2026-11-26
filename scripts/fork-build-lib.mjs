// Fork-only (Khang5687/paseo); never upstreamed.
// Helpers shared by the fork build scripts (fork-prepare, fork-android-apk, fork-build,
// fork-sync): input hashes for skip-when-unchanged stamps, free disk space, a per-checkout lock,
// and step timing.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statfsSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Below this, no build starts (CLAUDE.md "Build it" step 1).
export const MIN_FREE_GB = 8;
// The APK's JS bundle step is the disk peak: on 2026-11-01 an incremental APK build took the disk
// from about 9.7 GB to 122 MB free. The Android build dir is about 1.5 GB and the owner's APK
// builds finished with 11 GB free, so 6 GB keeps about 4.5 GB above the build dir.
export const ANDROID_MIN_FREE_GB = 6;

export function freeGb(dir = "/") {
  const stats = statfsSync(dir);
  return (stats.bavail * stats.bsize) / 1024 ** 3;
}

export function gitRoot(cwd = process.cwd()) {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${cwd} is not inside a git checkout.`);
  return result.stdout.trim();
}

/**
 * Why a build must not start in `root`, or null when it may: builds merge, check and push from
 * the main checkout, so it has to be on main with a clean tree. An edit made there while a build
 * runs (an agent working in the wrong checkout) crashes the check halfway.
 */
export function checkoutProblem(root) {
  const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" }).stdout.trim();
  const branch = git(["branch", "--show-current"]);
  if (branch !== "main") {
    return `${root} is on ${branch || "a detached HEAD"}, not main. Builds run on main in the main checkout.`;
  }
  const changes = git(["status", "--porcelain"]).split("\n").filter(Boolean);
  if (changes.length === 0) return null;
  const shown = changes.slice(0, 5).join("; ");
  return (
    `${root} has ${changes.length} uncommitted change(s): ${shown}${changes.length > 5 ? "; ..." : ""}. ` +
    "Someone is editing the main checkout. Builds merge and check there, so an edit mid-build breaks them. " +
    "Commit or discard the change (agents work in their own worktree), then rerun."
  );
}

/**
 * sha256 over `extra` strings and the content of every file under `paths` that git sees in the
 * working tree: tracked (including uncommitted edits) and untracked, minus ignored files, so build
 * outputs such as dist/ never feed their own stamp.
 */
export function hashInputs(root, paths, extra = []) {
  const hash = createHash("sha256");
  for (const value of extra) hash.update(`${value}\0`);
  const listed = spawnSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...paths],
    { cwd: root, maxBuffer: 64 * 1024 * 1024 },
  );
  if (listed.status !== 0) throw new Error(`git ls-files failed:\n${listed.stderr}`);
  const files = [...new Set(listed.stdout.toString("utf8").split("\0").filter(Boolean))].sort();
  for (const file of files) {
    hash.update(`${file}\0`);
    try {
      hash.update(readFileSync(path.join(root, file)));
    } catch (error) {
      // Tracked but deleted in the working tree.
      if (error.code !== "ENOENT") throw error;
      hash.update("\0deleted");
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function readStamp(file) {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Takes `lockPath`, waiting while a live process holds it. Returns the release function. */
export function acquireLock(lockPath, log) {
  let announced = false;
  for (;;) {
    try {
      writeFileSync(lockPath, String(process.pid), { flag: "wx" });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const holder = Number(readStamp(lockPath));
    if (!holder || !isAlive(holder)) {
      // The holder exited without releasing it.
      try {
        unlinkSync(lockPath);
      } catch {}
      continue;
    }
    if (!announced) log(`waiting for pid ${holder} (${lockPath})`);
    announced = true;
    sleep(2000);
  }
  const release = () => {
    try {
      if (readStamp(lockPath) === String(process.pid)) unlinkSync(lockPath);
    } catch {}
  };
  process.on("exit", release);
  return release;
}

export function formatSeconds(seconds) {
  const s = Math.round(seconds);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** Times named steps, logs each one as it ends, and prints them all as a table at the end. */
export function createTimer(log) {
  const started = Date.now();
  const rows = [];
  const record = (name, seconds, note = "") => {
    rows.push({ name, seconds, note });
    log(`${name}: ${note ? `${note}, ` : ""}${formatSeconds(seconds)}`);
  };
  return {
    record,
    run(name, fn) {
      const t = Date.now();
      try {
        return fn();
      } finally {
        record(name, (Date.now() - t) / 1000);
      }
    },
    table() {
      const width = Math.max(5, ...rows.map((row) => row.name.length));
      const line = (name, seconds, note) =>
        `| ${name.padEnd(width)} | ${formatSeconds(seconds).padStart(7)} | ${note} |`;
      return [
        `| ${"step".padEnd(width)} | ${"time".padStart(7)} | note |`,
        `| ${"-".repeat(width)} | ${"-".repeat(7)} | ---- |`,
        ...rows.map((row) => line(row.name, row.seconds, row.note)),
        line("total", (Date.now() - started) / 1000, "wall clock"),
      ].join("\n");
    },
  };
}

/**
 * How the builds after a green check share the disk. Remote daemon builds run on their hosts and
 * always start. The desktop build needs MIN_FREE_GB. The APK runs beside it only when the disk
 * holds MIN_FREE_GB + ANDROID_MIN_FREE_GB (14 GB); with room for the APK alone it waits for the
 * desktop build (and re-checks ANDROID_MIN_FREE_GB itself then); with less it does not run.
 */
export function planBuilds({ freeGb: free, android }) {
  if (free < MIN_FREE_GB) {
    return {
      stop: `${free.toFixed(1)} GB free, below ${MIN_FREE_GB} GB; free disk space and rerun.`,
    };
  }
  if (!android) return { android: "skip" };
  if (free >= MIN_FREE_GB + ANDROID_MIN_FREE_GB) return { android: "parallel" };
  return { android: free >= ANDROID_MIN_FREE_GB ? "after-desktop" : "no-disk" };
}

/**
 * The paseo CLI the fork scripts use to start and message agents: $PASEO_CLI, else the build the
 * host's daemon runs (~/paseo-fork/current, see fork-remote-daemon.sh), else `paseo` on PATH.
 * Timer and systemd units have a clean environment, so PATH alone is not enough there.
 */
export function paseoCli() {
  if (process.env.PASEO_CLI) return process.env.PASEO_CLI;
  const fork = path.join(os.homedir(), "paseo-fork/current/packages/cli/bin/paseo");
  return existsSync(fork) ? fork : "paseo";
}

/**
 * The message fork-build-bg.mjs sends the agent that asked for a build, built from the result
 * file fork-build wrote (`result` is null when it crashed before writing one). `notifyId` and
 * `prs` rebuild the rerun command. A green build says so in one line; anything else names the PRs
 * and the next step, so the woken agent does not have to work it out from the summary.
 */
export function buildMessage({ result, exitCode, summary, notifyId, prs, logDir }) {
  const rerun = (list) =>
    `node scripts/fork-build-bg.mjs --notify ${notifyId} ${list.map((pr) => `--pr ${pr}`).join(" ")}`.trim();
  const skipped = result?.skipped ?? [];
  const skippedPrs = skipped.map((line) => /^#(\d+)/.exec(line)?.[1]).filter(Boolean);
  const code = result?.code ?? exitCode;
  const next =
    'Next: CLAUDE.md "Build it" step 3 onward (remote daemons, handoff file, report to the owner).';
  const lines = [];
  if (result === null) {
    lines.push(
      `Fork build CRASHED (exit ${exitCode}) before it wrote a result. Read the log in ${logDir}, fix the cause, and rerun: ${rerun(prs)}`,
    );
  } else if (result.dryRun) {
    lines.push(
      `Fork build DRY RUN finished (exit ${code}): nothing was merged, pushed or built. The summary below says what a real run would do.`,
    );
  } else if (code === 0 && skipped.length === 0) {
    lines.push("Fork build finished: green. Every PR merged and every build passed.", next);
  } else if (code === 0) {
    lines.push(
      `Fork build finished and pushed main, but ${skipped.length} PR(s) were skipped: ${skippedPrs.map((pr) => `#${pr}`).join(", ")} (a conflict, a draft or a closed PR; the lines below say which).`,
      "Fix a conflict on that PR's own branch, never on main: in its worktree run `git fetch origin && git merge origin/main`, resolve, push the branch. Then rerun only the skipped PRs:",
      rerun(skippedPrs),
      next,
    );
  } else if (code === 4) {
    lines.push(
      "Fork build did not start its builds: not enough free disk. Tell the owner to free space (agents do not delete the owner's files), then rerun:",
      rerun(prs),
    );
  } else {
    lines.push(
      `Fork build FAILED (exit ${code}).${skipped.length > 0 ? ` Skipped PRs: ${skippedPrs.map((pr) => `#${pr}`).join(", ")}.` : ""}`,
      "If the summary says the check failed: nothing was pushed and local main still has the merges. Find the PR that broke it in the report, run `git reset --hard origin/main` in the main checkout, set that PR's handoff entry to blocked, and rerun without it. If it says another fork-sync is running or the push was refused, wait and rerun. Rerun command (drop the blocked PRs):",
      rerun(prs),
    );
  }
  lines.push("", "---", summary.trim(), "", `Logs: ${logDir}`);
  return lines.join("\n");
}

/**
 * What the nightly sync does with fork-sync's exit code (see its header): 0 and 3 need no agent,
 * 1 (checks failed) and 2 (conflicts) start one resolver, anything else is a crash.
 */
export function syncOutcome(code) {
  if (code === 0) return { kind: "done", note: "main is level with upstream or merged cleanly" };
  if (code === 3) return { kind: "skip", note: "another fork-sync is running" };
  if (code === 1) return { kind: "agent", note: "the checks failed on the merged tree" };
  if (code === 2) return { kind: "agent", note: "the merge conflicts" };
  return { kind: "crash", note: `fork-sync exited ${code}` };
}

/** The brief the nightly sync gives its resolver agent. */
export function syncAgentPrompt({ code, why, reportPath, checkout, worktree }) {
  return [
    `The nightly upstream sync did not finish green: ${why} (fork-sync exit ${code}).`,
    `Report: ${reportPath}`,
    "",
    `Resolve it per CLAUDE.md "Syncing with upstream" in ${checkout}/CLAUDE.md. Use absolute paths and edit only in the sync worktree ${worktree}, never in ${checkout}.`,
    code === 2
      ? `Conflicts: the nightly run aborted its merge, so redo it with \`node scripts/fork-sync.mjs --apply\` from ${checkout} (it leaves the conflicts in the worktree), resolve them, commit, then \`node scripts/fork-sync.mjs --apply --resume\`.`
      : `Checks failed: the merge is committed in the worktree. Fix what upstream broke as commits on top of it, then \`node scripts/fork-sync.mjs --apply --resume\` from ${checkout}.`,
    "Run fork scripts as `SHELL=/bin/bash env -u SSH_CONNECTION -u SSH_CLIENT -u SSH_TTY mise exec -- node scripts/<name>.mjs`. Watch a long job with one async watcher and end the turn; never repeat waits.",
    "Never restart the 6767 daemon, never pass --now, never install the Mac app, never push to main by hand. Do not contact the owner. Your final reply is the result: what conflicted or broke, how you resolved it, and whether main was pushed.",
  ].join("\n");
}
