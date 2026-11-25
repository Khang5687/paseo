import type { InlinePathTarget } from "./parse";
import type { GetDirectorySuggestions } from "./resolver";
import { matchToolCallFilePaths } from "./tool-call-paths";

/** Matches one daemon lookup returns before the chat asks which file a link means. */
const LOOKUP_LIMIT = 8;

export interface FileLinkLadderInput {
  /** The name to find: workspace-relative, or a bare file name. */
  query: string;
  target: InlinePathTarget;
  /** The agent's working directory, searched first. */
  cwd: string;
  /** Workspace and project roots to search when the cwd has no match, skipping the cwd itself. */
  extraRoots: readonly string[];
  /** Files the agent's own tool calls named. */
  knownPaths: readonly string[];
  /** Whether the host can search Git-ignored files. */
  searchIgnored: boolean;
  getDirectorySuggestions: GetDirectorySuggestions;
}

/** Thrown when the user dismisses the "which file?" picker. Not an error worth a toast. */
export class FileLinkPickCancelledError extends Error {
  constructor() {
    super("File link pick cancelled");
    this.name = "FileLinkPickCancelledError";
  }
}

/**
 * The folders searched after the agent's cwd: its workspace folder, then the project root. Each
 * is cleaned of trailing slashes, and the cwd and repeats are dropped.
 */
export function resolveFileLinkSearchRoots(input: {
  workspaceRoot: string;
  workspaceFolder?: string;
  projectFolder?: string;
}): string[] {
  const clean = (path: string | undefined) => path?.trim().replace(/[\\/]+$/, "") ?? "";
  const cwd = clean(input.workspaceRoot);
  const roots: string[] = [];
  for (const candidate of [clean(input.workspaceFolder), clean(input.projectFolder)]) {
    if (candidate && candidate !== cwd && !roots.includes(candidate)) roots.push(candidate);
  }
  return roots;
}
/**
 * Finds the files a bare or relative chat name can mean. The first step with a hit answers:
 *
 * 1. the agent's own tool-call paths, no daemon call;
 * 2. the cwd, then the cwd again including Git-ignored files and build output;
 * 3. the workspace root and the project root, each searched the same way.
 *
 * More than one entry means the name is ambiguous at that step. Empty means the ladder missed.
 */
export async function resolveFileLinkCandidates(
  input: FileLinkLadderInput,
  /** The daemon steps. Callers pass a cached version; the default asks the daemon every time. */
  lookup: (
    input: FileLinkLadderInput,
  ) => Promise<InlinePathTarget[]> = lookupFileCandidatesOnDaemon,
): Promise<InlinePathTarget[]> {
  const known = matchKnownFileTargets(input);
  if (known.length > 0) return known;
  return lookup(input);
}

/** Step 1 of the ladder: files the agent's tool calls named that the link's name matches. */
export function matchKnownFileTargets(
  input: Pick<FileLinkLadderInput, "query" | "target" | "cwd" | "knownPaths">,
): InlinePathTarget[] {
  return matchToolCallFilePaths({
    query: input.query,
    cwd: input.cwd,
    knownPaths: input.knownPaths,
  }).map((path) => withPath(input.target, path));
}

/** Steps 2 and 3 of the ladder: the daemon's suffix search. */
export async function lookupFileCandidatesOnDaemon(
  input: FileLinkLadderInput,
): Promise<InlinePathTarget[]> {
  const roots = [input.cwd, ...input.extraRoots.filter((root) => root !== input.cwd)];
  for (const root of roots) {
    let paths = await searchRoot(input, root, false);
    if (paths.length === 0 && input.searchIgnored) paths = await searchRoot(input, root, true);
    if (paths.length > 0) return paths.map((path) => withPath(input.target, path));
  }
  return [];
}

function withPath(target: InlinePathTarget, path: string): InlinePathTarget {
  return { ...target, path };
}

async function searchRoot(
  input: FileLinkLadderInput,
  root: string,
  includeIgnored: boolean,
): Promise<string[]> {
  const query = input.query.replace(/\/+$/, "");
  // An extensionless name may be a folder (`src/components/`, `packages/app/src`); a name
  // with an extension is only ever looked up as a file.
  const lastSegment = query.split("/").at(-1) ?? "";
  try {
    const result = await input.getDirectorySuggestions({
      query,
      cwd: root,
      includeFiles: true,
      includeDirectories: !/.\.[^.]+$/.test(lastSegment),
      matchMode: "suffix",
      limit: LOOKUP_LIMIT,
      ...(includeIgnored ? { includeIgnored: true } : {}),
    });
    if (result.error) return [];
    const paths = result.entries.map((entry) => joinRoot(root, entry.path));
    // A path that names the file exactly is the link's target, not one of several.
    const exact = joinRoot(root, query);
    return paths.includes(exact) ? [exact] : paths;
  } catch {
    return [];
  }
}

function joinRoot(root: string, relativePath: string): string {
  const base = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const child = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  return base ? `${base}/${child}` : child;
}
