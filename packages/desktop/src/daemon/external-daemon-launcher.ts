import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

/**
 * A daemon launched from outside the app bundle. When `$PASEO_HOME/fork-daemon/launch` is an
 * executable file, Desktop runs it to start the daemon instead of spawning the copy inside its own
 * bundle. The Paseo fork's `scripts/fork-daemon.sh` writes it: the fork daemon runs from its own
 * copy of a build, so a new app bundle can be installed while that daemon keeps working.
 *
 * Desktop never captures a daemon started this way, the same as any daemon it did not spawn:
 * quitting the app leaves it running and a version mismatch does not restart it. Whoever owns the
 * launcher replaces the daemon.
 */
export function resolveExternalDaemonLauncher(home: string): string | null {
  const launcher = path.join(home, "fork-daemon", "launch");
  try {
    if (!statSync(launcher).isFile()) return null;
    accessSync(launcher, constants.X_OK);
    return launcher;
  } catch {
    return null;
  }
}

/** Runs the launcher to completion; it returns once the daemon is ready or has failed to start. */
export function runExternalDaemonLauncher(input: {
  launcher: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.launcher, [], {
      env: input.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4_000);
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${input.launcher} did not finish within ${input.timeoutMs}ms`));
    }, input.timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      const reason = signal ? `signal ${signal}` : `exit ${code}`;
      reject(new Error(`${input.launcher} failed (${reason}): ${stderr.trim()}`));
    });
  });
}
