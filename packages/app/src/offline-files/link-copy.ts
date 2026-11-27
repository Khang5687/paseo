import type { OfflineFile } from "./store";

/** What a chat link names, in terms the Saved index can match. */
export type SavedLinkTarget =
  /** A web link to a file: only its name can be matched, on any host. */
  | { kind: "name"; fileName: string }
  /** A host file with a known absolute path. */
  | { kind: "path"; serverId: string; path: string }
  /** A bare or partial path the host would still have to look up: matched as a path suffix. */
  | { kind: "suffix"; serverId: string; suffix: string };

// A last path segment with an extension, like `paseo-fork-main.apk`. A page (`/docs/`) is not a file.
const FILE_NAME = /^[^/\\]+\.[A-Za-z0-9]{1,10}$/;

/** The file name an http(s) link downloads, or null when the link is not to a file. */
export function fileNameFromWebUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const segment = parsed.pathname.split("/").pop() ?? "";
  let name: string;
  try {
    name = decodeURIComponent(segment);
  } catch {
    name = segment;
  }
  return FILE_NAME.test(name) ? name : null;
}

function matches(file: OfflineFile, target: SavedLinkTarget): boolean {
  if (target.kind === "name") return file.path.split(/[\\/]/).pop() === target.fileName;
  if (file.serverId !== target.serverId) return false;
  if (target.kind === "path") return file.path === target.path;
  const suffix = target.suffix.replace(/^[\\/]+/, "");
  return suffix.length > 0 && (file.path === suffix || file.path.endsWith(`/${suffix}`));
}

/**
 * The saved copy a chat link should open instead of fetching the file again: the newest copy of
 * the linked file saved after the message was written. Build links reuse one file name for every
 * build (`paseo-fork-main.apk`), so a copy saved before the message can be an older build and
 * never counts.
 */
export function findSavedLinkCopy(
  files: readonly OfflineFile[],
  target: SavedLinkTarget,
  messageAt: number,
): OfflineFile | null {
  let newest: OfflineFile | null = null;
  for (const file of files) {
    if (file.savedAt <= messageAt || !matches(file, target)) continue;
    if (!newest || file.savedAt > newest.savedAt) newest = file;
  }
  return newest;
}
