import type { OfflineFile } from "./store";

export interface SavedFileGroup {
  serverId: string;
  totalBytes: number;
  /** Newest first. */
  files: OfflineFile[];
}

/**
 * Saved files grouped by host, each group newest first, keeping only paths that contain `query`
 * (case-insensitive). Groups follow `hostOrder`; hosts the app no longer knows come last.
 */
export function groupSavedFiles(
  files: readonly OfflineFile[],
  input: { query: string; hostOrder: readonly string[] },
): SavedFileGroup[] {
  const query = input.query.trim().toLowerCase();
  const groups = new Map<string, SavedFileGroup>();
  for (const file of files) {
    if (query && !file.path.toLowerCase().includes(query)) continue;
    let group = groups.get(file.serverId);
    if (!group) {
      group = { serverId: file.serverId, totalBytes: 0, files: [] };
      groups.set(file.serverId, group);
    }
    group.totalBytes += file.size;
    group.files.push(file);
  }
  const rank = (serverId: string) => {
    const index = input.hostOrder.indexOf(serverId);
    return index === -1 ? input.hostOrder.length : index;
  };
  return [...groups.values()]
    .map((group) => ({ ...group, files: group.files.sort((a, b) => b.savedAt - a.savedAt) }))
    .sort((a, b) => rank(a.serverId) - rank(b.serverId) || a.serverId.localeCompare(b.serverId));
}
