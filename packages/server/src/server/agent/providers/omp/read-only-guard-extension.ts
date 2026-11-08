/**
 * OMP extension that Paseo loads (`--extension`) into every OMP it launches in read-only mode.
 *
 * Read-only launches OMP with `--approval-mode always-ask`: bash, edit, write, eval, task and host
 * tools ask, but read-tier tools run without a prompt, and OMP's `read`, `grep` and `glob` accept
 * any path: absolute, `~`, `@/`, `..`, `file://`, URLs, internal URLs, and symlinks that lead out
 * of the folder. This extension blocks such a call unless every path it names stays inside the
 * session folder. It also checks bash's `cwd`, which OMP's approval prompt does not show, and
 * blocks the read-tier tools that reach outside the folder without a path it could check. `read`
 * resolves a missing path by suffix match anywhere in the folder, so its result is checked too.
 *
 * OMP starts without an extension that fails to load, so the extension registers a slash command
 * that only says it is active; Paseo refuses to start read-only OMP unless OMP lists it.
 *
 * This module runs inside OMP's process: it imports only Node built-ins.
 */
import { realpath } from "node:fs/promises";
import path from "node:path";

/** The slash command whose presence in OMP's command list shows the guard loaded. */
export const OMP_READ_ONLY_GUARD_COMMAND = "paseo-read-only-guard";

interface GuardContext {
  cwd: string;
}

interface GuardToolCallEvent {
  toolName: string;
  input?: Record<string, unknown>;
}

interface GuardToolResultEvent {
  toolName: string;
  details?: unknown;
}

interface GuardBlock {
  block: true;
  reason: string;
}
interface GuardResultOverride {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
}

interface GuardExtensionApi {
  registerCommand(name: string, options: { description: string; handler: () => void }): void;
  on(
    event: "tool_call",
    handler: (event: GuardToolCallEvent, ctx: GuardContext) => Promise<GuardBlock | undefined>,
  ): void;
  on(
    event: "tool_result",
    handler: (
      event: GuardToolResultEvent,
      ctx: GuardContext,
    ) => Promise<GuardResultOverride | undefined>,
  ): void;
}

/** The arguments of each guarded tool that name files or folders (OMP 18.13). */
const PATH_ARGUMENTS: Readonly<Record<string, readonly string[]>> = {
  read: ["path"],
  grep: ["path", "paths"],
  glob: ["path", "paths"],
  find: ["path", "paths"],
  ast_grep: ["path", "paths"],
  bash: ["cwd"],
};

/**
 * Read-tier tools (no prompt under always-ask) that reach outside the folder through arguments
 * this guard cannot check: language servers, debuggers, the user's GitHub token, IDA. None is in
 * OMP's default tool set; settings can enable them.
 */
const BLOCKED_TOOLS: Readonly<Record<string, true>> = {
  lsp: true,
  debug: true,
  github: true,
  ida: true,
};

// Plain ASCII path or glob characters. Quotes and backslashes are refused, since OMP unescapes
// and splits delimited lists before it resolves them.
const PLAIN_PATH = /^[\w.+\-/*?[\]{}!,:=@# ]+$/;
// A list entry, brace alternative or selector OMP may split off and resolve on its own.
const ENTRY_SEPARATOR = /[\s,{}]+/;
// OMP rewrites these leading forms (`/` root, `~` home, `@/` and `:/` shorthands) before it
// resolves a path, so none may start any entry.
const OUTSIDE_START = /^[/~@:]/;
const GLOB_CHAR = /[*?[{!]/;

/** Why `entry` may not name a path in read-only mode, or undefined when it stays in `root`. */
async function pathEntryBlockReason(entry: unknown, root: string): Promise<string | undefined> {
  if (typeof entry !== "string") return "a path that is not a string";
  if (entry === "") return undefined;
  if (!PLAIN_PATH.test(entry) || entry.includes("..") || entry.includes(":/")) {
    return `path ${JSON.stringify(entry)}`;
  }
  const pieces = entry.split(ENTRY_SEPARATOR).filter((piece) => piece !== "");
  if (pieces.some((piece) => OUTSIDE_START.test(piece))) return `path ${JSON.stringify(entry)}`;
  // Every form OMP may resolve: the whole entry, each split-off piece, and each part before a
  // `:line` selector. Each, cut before its first glob character, must resolve inside the folder.
  const candidates = new Set<string>();
  for (const form of [entry, ...pieces]) {
    candidates.add(form);
    let colon = form.indexOf(":");
    while (colon !== -1) {
      candidates.add(form.slice(0, colon));
      colon = form.indexOf(":", colon + 1);
    }
  }
  for (const candidate of candidates) {
    const glob = candidate.search(GLOB_CHAR);
    const literal = glob === -1 ? candidate : candidate.slice(0, glob);
    if (!(await staysInside(path.resolve(root, literal), root))) {
      return `path ${JSON.stringify(entry)}`;
    }
  }
  return undefined;
}

/** Whether `target`, or its nearest existing ancestor, resolves (symlinks followed) inside `root`. */
async function staysInside(target: string, root: string): Promise<boolean> {
  let current = target;
  for (;;) {
    try {
      const resolved = await realpath(current);
      return resolved === root || resolved.startsWith(`${root}${path.sep}`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const parent = path.dirname(current);
      if ((code !== "ENOENT" && code !== "ENOTDIR") || parent === current) return false;
      current = parent;
    }
  }
}

/** Why this tool call must not run in read-only mode, or undefined when it may. */
export async function toolCallBlockReason(
  toolName: string,
  input: Record<string, unknown> | undefined,
  sessionCwd: string,
): Promise<string | undefined> {
  if (Object.hasOwn(BLOCKED_TOOLS, toolName)) {
    return `Paseo read-only mode does not run ${toolName}: it reaches outside ${sessionCwd}.`;
  }
  if (!Object.hasOwn(PATH_ARGUMENTS, toolName)) return undefined;
  const argumentNames = PATH_ARGUMENTS[toolName];
  const refusal = (what: string) =>
    `Paseo read-only mode reads only inside ${sessionCwd}; ${toolName} was given ${what}. Use paths relative to that folder, without "..", "~", URLs or symlinks that lead out.`;
  let root: string;
  try {
    root = await realpath(sessionCwd);
  } catch {
    return refusal("a session folder that does not resolve");
  }
  for (const name of argumentNames) {
    const value = input?.[name];
    if (value === undefined) continue;
    let entries: unknown[] = Array.isArray(value) ? value : [value];
    // OMP decodes a JSON-encoded array in a search path the same way.
    if (typeof value === "string" && value.trimStart().startsWith("[")) {
      try {
        const decoded: unknown = JSON.parse(value);
        if (Array.isArray(decoded)) entries = [value, ...decoded];
      } catch {
        // Not JSON: the string itself is checked below.
      }
    }
    for (const entry of entries) {
      const reason = await pathEntryBlockReason(entry, root);
      if (reason !== undefined) return refusal(reason);
    }
  }
  return undefined;
}

/**
 * Why a `read` result must not reach the model, or undefined when it may: the file OMP actually
 * read (`resolvedPath` after a suffix match, else the result's source path) left the folder.
 */
export async function readResultBlockReason(
  details: unknown,
  sessionCwd: string,
): Promise<string | undefined> {
  if (typeof details !== "object" || details === null) return undefined;
  const { resolvedPath, meta } = details as { resolvedPath?: unknown; meta?: unknown };
  const source = (meta as { source?: { type?: unknown; value?: unknown } } | undefined)?.source;
  const read = [resolvedPath, source?.type === "path" ? source.value : undefined].filter(
    (value): value is string => typeof value === "string",
  );
  const refusal = `Paseo read-only mode reads only inside ${sessionCwd}; this read resolved to a file outside it.`;
  let root: string;
  try {
    root = await realpath(sessionCwd);
  } catch {
    return refusal;
  }
  for (const file of read) {
    if (!(await staysInside(path.resolve(root, file), root))) return refusal;
  }
  return undefined;
}

export default function paseoReadOnlyGuard(pi: GuardExtensionApi): void {
  pi.registerCommand(OMP_READ_ONLY_GUARD_COMMAND, {
    description: "Paseo read-only guard is active",
    handler: () => undefined,
  });
  pi.on("tool_call", async (event, ctx) => {
    const reason = await toolCallBlockReason(event.toolName, event.input, ctx.cwd);
    return reason === undefined ? undefined : { block: true, reason };
  });
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "read") return undefined;
    const reason = await readResultBlockReason(event.details, ctx.cwd);
    return reason === undefined
      ? undefined
      : { content: [{ type: "text", text: reason }], isError: true };
  });
}
