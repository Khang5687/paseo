import { isAbsolutePath } from "@/utils/path";
import { resolveWorkspaceFilePaths } from "@/workspace/file-open";

export interface FilePathMenuPaths {
  /** Absolute path on the host. */
  absolutePath: string;
  /** Path relative to the workspace root, or null when the file lives outside it. */
  relativePath: string | null;
  fileName: string;
}

/**
 * Null when the path has no absolute form on the host: a `~/…` path while the host's home
 * directory is unknown, or a relative path without a workspace root to anchor it.
 */
export function resolveFilePathMenuPaths(input: {
  path: string;
  workspaceRoot: string;
  homeDirectory: string | null;
}): FilePathMenuPaths | null {
  const path = expandHomePath(input.path.trim(), input.homeDirectory);
  if (!path) {
    return null;
  }
  const workspaceRoot = input.workspaceRoot.trim();
  const workspacePaths = workspaceRoot ? resolveWorkspaceFilePaths({ path, workspaceRoot }) : null;
  if (workspacePaths) {
    return { ...workspacePaths, fileName: baseName(workspacePaths.absolutePath) };
  }
  if (!isAbsolutePath(path)) {
    return null;
  }
  return { absolutePath: path, relativePath: null, fileName: baseName(path) };
}

function expandHomePath(path: string, homeDirectory: string | null): string | null {
  const isHomeRelative = path === "~" || path.startsWith("~/") || path.startsWith("~\\");
  if (!isHomeRelative) {
    return path || null;
  }
  const home = homeDirectory?.trim().replace(/[\\/]+$/, "");
  if (!home) {
    return null;
  }
  const rest = path.slice(2);
  return rest ? `${home}/${rest}` : home;
}

function baseName(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) ?? path;
}
