import type {
  AgentFileExplorerState,
  ExplorerDirectory,
  ExplorerEntry,
} from "@/stores/session-store";

export const DIRECTORY_LISTING_INVALIDATED = Symbol("directory-listing-invalidated");
export type DirectoryListingResult =
  | ExplorerDirectory
  | null
  | typeof DIRECTORY_LISTING_INVALIDATED;

type UpdateExplorerState = (
  update: (state: AgentFileExplorerState) => AgentFileExplorerState,
) => AgentFileExplorerState | null;

function pushHistory(history: string[], path: string): string[] {
  const normalizedHistory = history.length === 0 ? ["."] : history;
  return normalizedHistory.at(-1) === path ? normalizedHistory : [...normalizedHistory, path];
}

export async function loadExplorerDirectory({
  path,
  options,
  updateState,
  listDirectory,
  fallbackError,
}: {
  path: string;
  options?: { recordHistory?: boolean; setCurrentPath?: boolean };
  updateState: UpdateExplorerState;
  listDirectory: () => Promise<ExplorerDirectory>;
  fallbackError: string;
}): Promise<DirectoryListingResult> {
  const shouldSetCurrentPath = options?.setCurrentPath ?? true;
  const shouldRecordHistory = options?.recordHistory ?? shouldSetCurrentPath;
  const initial = updateState((state) => ({
    ...state,
    isLoading: true,
    lastError: null,
    pendingRequest: { path, mode: "list" },
    ...(shouldSetCurrentPath
      ? {
          currentPath: path,
          history: shouldRecordHistory ? pushHistory(state.history, path) : state.history,
          lastVisitedPath: path,
        }
      : {}),
  }));
  if (!initial) return null;
  const generation = initial.listingGeneration;
  try {
    const directory = await listDirectory();
    let accepted = false;
    updateState((state) => {
      if (state.listingGeneration !== generation) return state;
      accepted = true;
      const directories = new Map(state.directories);
      directories.set(directory.path, directory);
      return { ...state, directories, isLoading: false, lastError: null, pendingRequest: null };
    });
    return accepted ? directory : DIRECTORY_LISTING_INVALIDATED;
  } catch (error) {
    let invalidated = false;
    updateState((state) => {
      if (state.listingGeneration !== generation) {
        invalidated = true;
        return state;
      }
      return {
        ...state,
        isLoading: false,
        lastError: error instanceof Error ? error.message : fallbackError,
        pendingRequest: null,
      };
    });
    return invalidated ? DIRECTORY_LISTING_INVALIDATED : null;
  }
}

/**
 * Background re-list for a folder the daemon reported as changed. Unlike
 * `loadExplorerDirectory` it shows no spinner and no error: a folder that vanished drops
 * out of its parent's listing, and a failed re-list keeps the old one. An unchanged
 * listing keeps the same object, so rows do not re-render.
 */
export async function reloadExplorerDirectory({
  readState,
  updateState,
  listDirectory,
}: {
  readState: () => AgentFileExplorerState | undefined;
  updateState: UpdateExplorerState;
  listDirectory: () => Promise<ExplorerDirectory>;
}): Promise<void> {
  const generation = readState()?.listingGeneration;
  if (generation === undefined) return;
  let directory: ExplorerDirectory;
  try {
    directory = await listDirectory();
  } catch {
    return;
  }
  updateState((state) => {
    if (state.listingGeneration !== generation) return state;
    const current = state.directories.get(directory.path);
    if (current && sameEntries(current.entries, directory.entries)) return state;
    const directories = new Map(state.directories);
    directories.set(directory.path, directory);
    return { ...state, directories };
  });
}

function sameEntries(a: readonly ExplorerEntry[], b: readonly ExplorerEntry[]): boolean {
  return (
    a.length === b.length &&
    a.every((entry, index) => {
      const other = b[index];
      return (
        entry.path === other.path &&
        entry.kind === other.kind &&
        entry.size === other.size &&
        entry.modifiedAt === other.modifiedAt
      );
    })
  );
}

/** Refresh invalidates earlier replies as well as listings of collapsed folders. */
export function invalidateExplorerDirectoryListings(
  updateState: UpdateExplorerState,
  retainedPaths: readonly string[],
): void {
  const retained = new Set(retainedPaths);
  updateState((state) => ({
    ...state,
    listingGeneration: state.listingGeneration + 1,
    directories: new Map([...state.directories].filter(([path]) => retained.has(path))),
    isLoading: false,
    pendingRequest: null,
    lastError: null,
  }));
}
