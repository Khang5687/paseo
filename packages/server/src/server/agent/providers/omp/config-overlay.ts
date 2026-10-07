import { randomUUID } from "node:crypto";
import { mkdtemp, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// OMP continues an active goal between turns only in the run modes listed in
// `goal.continuationModes`, and the default lists the TUI alone. Paseo drives OMP over
// RPC, so without "rpc" a goal stops when the agent first yields. No RPC changes a
// setting, so it rides in a `--config` overlay, which OMP layers above the user's global
// and project config.
const OMP_CONFIG_OVERLAY = "goal:\n  continuationModes:\n    - interactive\n    - rpc\n";

let overlayDirectory: Promise<string> | null = null;

/**
 * Writes the overlay and returns its path. OMP refuses to launch when a `--config` file is
 * missing or unreadable, so every launch rewrites it (the OS may clean the temp dir) and
 * swaps it in with a rename. The directory comes from `mkdtemp` (mode 0700): an overlay can
 * set any OMP setting, so it must not sit at a predictable path other users can write.
 */
export async function writeOmpConfigOverlay(): Promise<string> {
  try {
    overlayDirectory ??= mkdtemp(join(tmpdir(), "paseo-omp-"));
    return await writeOverlay(await overlayDirectory);
  } catch {
    overlayDirectory = mkdtemp(join(tmpdir(), "paseo-omp-"));
    return await writeOverlay(await overlayDirectory);
  }
}

async function writeOverlay(directory: string): Promise<string> {
  const path = join(directory, "config.yml");
  const staging = `${path}.${randomUUID()}`;
  await writeFile(staging, OMP_CONFIG_OVERLAY, { mode: 0o600 });
  await rename(staging, path);
  return path;
}
