import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveExternalDaemonLauncher,
  runExternalDaemonLauncher,
} from "./external-daemon-launcher";

const homes: string[] = [];

function makeHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "paseo-external-launcher-"));
  homes.push(home);
  return home;
}

function writeLauncher(home: string, body: string, mode = 0o755): string {
  const launcher = path.join(home, "fork-daemon", "launch");
  mkdirSync(path.dirname(launcher), { recursive: true });
  writeFileSync(launcher, `#!/bin/sh\n${body}\n`);
  chmodSync(launcher, mode);
  return launcher;
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("external daemon launcher", () => {
  it("is used only when the launcher is an executable file", () => {
    const home = makeHome();
    expect(resolveExternalDaemonLauncher(home)).toBeNull();

    const launcher = writeLauncher(home, "exit 0", 0o644);
    expect(resolveExternalDaemonLauncher(home)).toBeNull();

    chmodSync(launcher, 0o755);
    expect(resolveExternalDaemonLauncher(home)).toBe(launcher);

    rmSync(launcher);
    mkdirSync(launcher);
    expect(resolveExternalDaemonLauncher(home)).toBeNull();
  });

  it("passes the desktop environment to the launcher and waits for it", async () => {
    const home = makeHome();
    const marker = path.join(home, "marker");
    const launcher = writeLauncher(
      home,
      `sleep 0.2; printf '%s' "$LOGIN_SHELL_PATH" > "${marker}"`,
    );

    await runExternalDaemonLauncher({
      launcher,
      env: { ...process.env, LOGIN_SHELL_PATH: "/opt/tools/bin" },
      timeoutMs: 10_000,
    });

    expect(readFileSync(marker, "utf8")).toBe("/opt/tools/bin");
  });

  it("reports the launcher's error output when the daemon does not start", async () => {
    const home = makeHome();
    const launcher = writeLauncher(home, "echo 'release 2026 failed its last start' >&2; exit 1");

    await expect(
      runExternalDaemonLauncher({ launcher, env: process.env, timeoutMs: 10_000 }),
    ).rejects.toThrow(/exit 1\): release 2026 failed its last start/);
  });

  it("gives up on a launcher that hangs", async () => {
    const home = makeHome();
    const launcher = writeLauncher(home, "exec sleep 30");

    await expect(
      runExternalDaemonLauncher({ launcher, env: process.env, timeoutMs: 200 }),
    ).rejects.toThrow(/did not finish within 200ms/);
  });
});
