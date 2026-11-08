/**
 * OMP extension that Paseo loads (`--extension`) into every OMP it launches in read-only mode.
 *
 * Paseo approves a bash prompt in that mode when the command only reads, but OMP's prompt shows
 * only `Command:`, not the bash tool's `cwd` argument, so `{command: "cat hosts.yml", cwd:
 * "~/.config/gh"}` looks like a harmless read. OMP fires `tool_call` with the full input before
 * its approval gate, so this extension blocks any bash call whose `cwd` is not the session folder
 * itself; Paseo resolves the paths in a command against that folder, so a subfolder is blocked too.
 *
 * The extension reports itself with a status line on every bash call it lets through, before
 * OMP's approval prompt for that call. Paseo approves nothing for an OMP process until that line
 * arrived, so a guard that failed to load leaves every prompt to the user.
 *
 * This module runs inside OMP's process: it imports only Node built-ins.
 */
import { realpath } from "node:fs/promises";
import path from "node:path";

export const OMP_READ_ONLY_GUARD_STATUS_KEY = "paseo-read-only-guard";
export const OMP_READ_ONLY_GUARD_STATUS_TEXT = "active";

interface GuardContext {
  cwd: string;
  ui?: { setStatus?: (key: string, text: string | undefined) => void };
}

interface GuardToolCallEvent {
  toolName: string;
  input?: Record<string, unknown>;
}

interface GuardExtensionApi {
  on(
    event: "tool_call",
    handler: (
      event: GuardToolCallEvent,
      ctx: GuardContext,
    ) => Promise<{ block: true; reason: string } | undefined>,
  ): void;
}

// OMP rewrites `~`, `@`, `:` and `file://` prefixes and Unicode spaces before it resolves a cwd.
// Accepting only plain relative segments leaves nothing for those rewrites to change.
const PLAIN_RELATIVE_DIR = /^[\w+-][\w.+-]*(?:\/[\w.+-]+)*\/?$/;

/** Why a bash call with this `cwd` must not run in read-only mode, or undefined when it may. */
export async function bashCwdBlockReason(
  cwd: unknown,
  sessionCwd: string,
): Promise<string | undefined> {
  if (cwd === undefined || cwd === "") return undefined;
  const refusal = `Paseo read-only mode runs bash only in ${sessionCwd}. Drop the cwd argument and use paths relative to that folder.`;
  if (typeof cwd !== "string" || !PLAIN_RELATIVE_DIR.test(cwd)) return refusal;
  if (cwd.split("/").some((segment) => segment === "..")) return refusal;
  try {
    const root = await realpath(sessionCwd);
    const target = await realpath(path.resolve(sessionCwd, cwd));
    if (target === root) return undefined;
  } catch {
    // A cwd that does not resolve fails in OMP anyway; refuse it here too.
  }
  return refusal;
}

export default function paseoReadOnlyGuard(pi: GuardExtensionApi): void {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;
    const reason = await bashCwdBlockReason(event.input?.cwd, ctx.cwd);
    if (reason !== undefined) return { block: true, reason };
    ctx.ui?.setStatus?.(OMP_READ_ONLY_GUARD_STATUS_KEY, OMP_READ_ONLY_GUARD_STATUS_TEXT);
    return undefined;
  });
}
