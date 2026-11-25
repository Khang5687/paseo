import type { StreamItem } from "@/types/stream";
import { extractToolCallFilePath } from "@/utils/extract-tool-call-file-path";
import { isAbsolutePath } from "@/utils/path";

/**
 * The files an agent's own tool calls named: reads, edits, writes, searches and plain `cat`
 * commands. An agent that wrote `out/clip.mp4` and then mentions `clip.mp4` means that file, so
 * these paths are the first place a bare chat name is looked up.
 *
 * Relative tool paths join the tool's own directory when it has one, else the agent cwd. Results
 * are absolute, normalized, unique and ordered oldest first.
 */
export function collectToolCallFilePaths(items: readonly StreamItem[], cwd: string): string[] {
  const found = new Set<string>();
  for (const item of items) {
    if (item.kind !== "tool_call" || item.payload.source !== "agent") continue;
    const detail = item.payload.data.detail;
    const base = detail.type === "shell" && detail.cwd?.trim() ? detail.cwd.trim() : cwd;
    const paths = [extractToolCallFilePath(detail)];
    if (detail.type === "search" && detail.filePaths) paths.push(...detail.filePaths);
    for (const path of paths) {
      const absolute = path ? absoluteToolPath(path, base) : null;
      if (absolute) found.add(absolute);
    }
  }
  return [...found];
}

function absoluteToolPath(path: string, base: string): string | null {
  const trimmed = path.trim().replace(/\\/g, "/");
  if (!trimmed || trimmed.startsWith("~")) return null;
  const joined = isAbsolutePath(trimmed) ? trimmed : `${base.replace(/\\/g, "/")}/${trimmed}`;
  if (!isAbsolutePath(joined)) return null;
  return normalizeSegments(joined);
}

function normalizeSegments(path: string): string {
  const drive = /^[a-zA-Z]:/.exec(path)?.[0] ?? "";
  const segments: string[] = [];
  for (const segment of path.slice(drive.length).split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return `${drive}/${segments.join("/")}`;
}

/**
 * Tool-call paths that end with the lookup query, compared by whole segments and without case,
 * like the daemon's suffix search. A path that is exactly `cwd/query` is the one the link names,
 * so it stands alone.
 */
export function matchToolCallFilePaths(input: {
  query: string;
  cwd: string;
  knownPaths: readonly string[];
}): string[] {
  const querySegments = input.query
    .replace(/\\/g, "/")
    .toLowerCase()
    .split("/")
    .filter((segment) => segment && segment !== ".");
  if (querySegments.length === 0) return [];
  const matches = input.knownPaths.filter((known) => {
    const segments = known.toLowerCase().split("/").filter(Boolean);
    const offset = segments.length - querySegments.length;
    return (
      offset >= 0 && querySegments.every((segment, index) => segments[offset + index] === segment)
    );
  });
  if (matches.length < 2) return matches;
  const exact = normalizeSegments(`${input.cwd.replace(/\\/g, "/")}/${input.query}`);
  return matches.includes(exact) ? [exact] : matches;
}

interface PathEntry {
  items: readonly StreamItem[];
  cwd: string;
  paths: string[];
}

/**
 * `collectToolCallFilePaths` over a chat's settled items and its streaming head, remembered per
 * array so reading the paths for every link on screen scans the timeline once, not once per link.
 */
export function createToolCallPathIndex(): (
  tail: readonly StreamItem[],
  head: readonly StreamItem[],
  cwd: string,
) => string[] {
  let tailEntry: PathEntry | null = null;
  let headEntry: PathEntry | null = null;
  let merged: { tail: string[]; head: string[]; paths: string[] } | null = null;
  return (tail, head, cwd) => {
    if (tailEntry?.items !== tail || tailEntry.cwd !== cwd) {
      tailEntry = { items: tail, cwd, paths: collectToolCallFilePaths(tail, cwd) };
    }
    if (headEntry?.items !== head || headEntry.cwd !== cwd) {
      headEntry = { items: head, cwd, paths: collectToolCallFilePaths(head, cwd) };
    }
    if (headEntry.paths.length === 0) return tailEntry.paths;
    if (merged?.tail !== tailEntry.paths || merged.head !== headEntry.paths) {
      merged = {
        tail: tailEntry.paths,
        head: headEntry.paths,
        paths: [...new Set([...tailEntry.paths, ...headEntry.paths])],
      };
    }
    return merged.paths;
  };
}
