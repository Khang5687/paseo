// Fork-only (Khang5687/paseo); never upstreamed.
// Helpers shared by the fork build scripts (fork-prepare, fork-android-apk, fork-build,
// fork-sync): input hashes for skip-when-unchanged stamps, free disk space, a per-checkout lock,
// and step timing.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statfsSync, unlinkSync, writeFileSync } from "node:fs";
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
