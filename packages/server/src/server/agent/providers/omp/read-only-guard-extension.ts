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
 * One internal URL stays open: `skill://<name>[/<path>]` reads, so helpers can follow a skill.
 * OMP resolves the name against its loaded skills and refuses `..`; the guard only accepts plain
 * names and refuses a result whose file sits inside the folder but resolves outside it.
 *
 * Secret files stay unreadable even inside the folder (`isSecretPath`). A named path is refused
 * before the tool runs. A search over a folder cannot be told to skip a file, so the result of
 * `grep`, `glob`, `find` and `ast_grep` is replaced with an error when it lists a secret file.
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
  input?: Record<string, unknown>;
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
const PLAIN_PATH = /^[\w.+\-/*?[\]{}!,:;=@# ]+$/;
// A list entry, brace alternative or selector OMP may split off and resolve on its own.
const ENTRY_SEPARATOR = /[\s,;{}]+/;
// OMP rewrites these leading forms (`/` root, `~` home, `@/` and `:/` shorthands) before it
// resolves a path, so none may start any entry.
const OUTSIDE_START = /^[/~@:]/;
const GLOB_CHAR = /[*?[{!]/;
// `skill://<name>[/<path>]` with an optional line or `raw` selector. Plain characters only: no
// `..`, `%` escapes, query, fragment or empty segment, so OMP gets nothing to resolve but names.
const SKILL_URL = /^skill:\/\/[\w.-]+(?:\/[\w.+@-]+)*\/?(?::[\w+,-]+){0,2}$/;

/** Tools whose results list the files they searched or matched. */
const SEARCH_TOOLS: Readonly<Record<string, true>> = {
  grep: true,
  glob: true,
  find: true,
  ast_grep: true,
};

const SECRET_NAME: readonly RegExp[] = [
  /^\.env/,
  /\.pem$/,
  /\.key$/,
  /token/,
  /secret/,
  /^credentials/,
  /^\.netrc$/,
  /^\.npmrc$/,
  /^\.git-credentials$/,
  /^id_(?!.*\.pub$)/,
];

function isSkillUrl(value: string): boolean {
  return SKILL_URL.test(value) && !value.includes("..");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Whether the last part of `file` names a secret: `.env*`, `*.pem`, `*.key`, `id_*` (not `.pub`),
 * `*token*`, `*secret*`, `credentials*`, `.netrc`, `.npmrc`, `.git-credentials`, or `hosts.yml`
 * inside a `gh` folder (the GitHub CLI's token file). Case-insensitive; folders are not matched.
 */
export function isSecretPath(file: string): boolean {
  const parts = file
    .toLowerCase()
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part !== "" && part !== ".");
  const name = parts.at(-1);
  if (name === undefined) return false;
  return (
    SECRET_NAME.some((pattern) => pattern.test(name)) ||
    (name === "hosts.yml" && parts.at(-2) === "gh")
  );
}

/** A path argument the guard refuses: what it was, and whether it is outside or a secret. */
interface PathRefusal {
  secret: boolean;
  what: string;
}

/** Why `entry` may not name a path in read-only mode, or undefined when it stays in `root`. */
async function pathEntryBlockReason(
  toolName: string,
  entry: unknown,
  root: string,
): Promise<PathRefusal | undefined> {
  if (typeof entry !== "string") return { secret: false, what: "a path that is not a string" };
  if (entry === "") return undefined;
  const what = `path ${JSON.stringify(entry)}`;
  const outside: PathRefusal = { secret: false, what };
  const secret: PathRefusal = { secret: true, what };
  if (toolName === "read" && entry.startsWith("skill://")) {
    if (!isSkillUrl(entry)) return outside;
    // A secret-named file inside a skill is as unreadable as one in the folder.
    return entry.split(":").some((part) => isSecretPath(part)) ? secret : undefined;
  }
  if (!PLAIN_PATH.test(entry) || entry.includes("..") || entry.includes(":/")) return outside;
  const pieces = entry.split(ENTRY_SEPARATOR).filter((piece) => piece !== "");
  if (pieces.some((piece) => OUTSIDE_START.test(piece))) return outside;
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
  let refusal: PathRefusal | undefined;
  for (const candidate of candidates) {
    const glob = candidate.search(GLOB_CHAR);
    const literal = glob === -1 ? candidate : candidate.slice(0, glob);
    const resolved = await resolveInside(path.resolve(root, literal), root);
    if (resolved === undefined) return outside;
    // bash's `cwd` is a folder to run in, not a file to read.
    if (toolName !== "bash" && (isSecretPath(literal) || isSecretPath(resolved))) refusal = secret;
  }
  return refusal;
}

/**
 * `target` with symlinks resolved, or undefined when it leaves `root`. A missing tail is kept as
 * written after its nearest existing ancestor, which must itself resolve inside `root`.
 */
async function resolveInside(target: string, root: string): Promise<string | undefined> {
  let current = target;
  let tail = "";
  for (;;) {
    try {
      const resolved = await realpath(current);
      if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return undefined;
      return tail === "" ? resolved : path.join(resolved, tail);
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      const parent = path.dirname(current);
      if ((code !== "ENOENT" && code !== "ENOTDIR") || parent === current) return undefined;
      tail = tail === "" ? path.basename(current) : path.join(path.basename(current), tail);
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
  const refusal = ({ secret, what }: PathRefusal) =>
    secret
      ? `Paseo read-only mode hides secret files (.env, keys, tokens, credentials); ${toolName} was given ${what}, which names one. Read other files.`
      : `Paseo read-only mode reads only inside ${sessionCwd}; ${toolName} was given ${what}. Use paths relative to that folder, without "..", "~", URLs or symlinks that lead out. Only skill:// URLs are allowed, in read.`;
  let root: string;
  try {
    root = await realpath(sessionCwd);
  } catch {
    return refusal({ secret: false, what: "a session folder that does not resolve" });
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
      const blocked = await pathEntryBlockReason(toolName, entry, root);
      if (blocked !== undefined) return refusal(blocked);
    }
  }
  return undefined;
}

/**
 * Why a `read` result must not reach the model, or undefined when it may: the file OMP actually
 * read (`resolvedPath` after a suffix match, else the result's source path) left the folder or is
 * a secret file. A `skill://` read legitimately resolves outside the folder, so it only fails when
 * its file sits inside the folder lexically but resolves outside through a symlink.
 */
export async function readResultBlockReason(
  details: unknown,
  sessionCwd: string,
  inputPath?: unknown,
): Promise<string | undefined> {
  if (!isRecord(details)) return undefined;
  const { resolvedPath, meta } = details;
  const source = isRecord(meta) && isRecord(meta.source) ? meta.source : undefined;
  const read = [resolvedPath, source?.type === "path" ? source.value : undefined].filter(
    (value): value is string => typeof value === "string",
  );
  const refusal = `Paseo read-only mode reads only inside ${sessionCwd}; this read resolved to a file outside it.`;
  const secretRefusal =
    "Paseo read-only mode hides secret files (.env, keys, tokens, credentials); this read resolved to one.";
  let root: string;
  try {
    root = await realpath(sessionCwd);
  } catch {
    return refusal;
  }
  const isSkill = typeof inputPath === "string" && isSkillUrl(inputPath);
  for (const file of read) {
    const absolute = path.resolve(root, file);
    const resolved = await resolveInside(absolute, root);
    if (isSecretPath(file) || (resolved !== undefined && isSecretPath(resolved))) {
      return secretRefusal;
    }
    if (resolved !== undefined) continue;
    if (!isSkill) return refusal;
    // Outside the folder is the skill's home. Inside it lexically, a symlink led out.
    if (absolute === root || absolute.startsWith(`${root}${path.sep}`)) return refusal;
    if (isSecretPath(await realpath(absolute).catch(() => absolute))) return secretRefusal;
  }
  return undefined;
}

/** Where a search tool lists the files it searched or matched. */
function listedFiles(details: unknown): string[] {
  if (!isRecord(details)) return [];
  const { files, fileMatches, hits } = details;
  const listed: unknown[] = [];
  if (Array.isArray(files)) listed.push(...files);
  if (Array.isArray(fileMatches)) {
    listed.push(...fileMatches.map((match: unknown) => (isRecord(match) ? match.path : undefined)));
  }
  if (Array.isArray(hits)) {
    listed.push(...hits.map((hit: unknown) => (isRecord(hit) ? hit.rel : undefined)));
  }
  return listed.filter((file): file is string => typeof file === "string");
}

/**
 * Why a `grep`, `glob`, `find` or `ast_grep` result must not reach the model, or undefined when
 * it may: it lists a secret file. These tools cannot be told to skip a file, so the whole result
 * goes. A listed name is checked as written, and again after symlinks resolve.
 */
export async function searchResultBlockReason(
  toolName: string,
  details: unknown,
  sessionCwd: string,
): Promise<string | undefined> {
  if (!Object.hasOwn(SEARCH_TOOLS, toolName)) return undefined;
  const base = isRecord(details) && typeof details.cwd === "string" ? details.cwd : sessionCwd;
  for (const file of listedFiles(details)) {
    // An archive member (`a.zip:dir/.env`) or a `:line` selector follows a `:`.
    let secret = file.split(":").some((part) => isSecretPath(part));
    if (!secret) {
      const real = await realpath(path.resolve(base, file)).catch(() => undefined);
      secret = real !== undefined && isSecretPath(real);
    }
    if (secret) {
      const advice =
        toolName === "grep"
          ? 'Search a narrower path, or exclude it, for example path "src;!**/.env".'
          : "Search a narrower path that does not reach it.";
      return `Paseo read-only mode hides secret files (.env, keys, tokens, credentials); this ${toolName} result included ${JSON.stringify(file)}, so it was dropped. ${advice}`;
    }
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
    const reason =
      event.toolName === "read"
        ? await readResultBlockReason(event.details, ctx.cwd, event.input?.path)
        : await searchResultBlockReason(event.toolName, event.details, ctx.cwd);
    return reason === undefined
      ? undefined
      : { content: [{ type: "text", text: reason }], isError: true };
  });
}
