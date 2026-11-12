import { useMemo } from "react";
import { shallow } from "zustand/shallow";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { useSessionStore } from "@/stores/session-store";

const EMPTY_WORKSPACE_PARENTS: ReadonlyMap<string, string> = new Map();

/** Child workspaceKey -> parent workspaceKey for subagent workspaces on the given hosts. */
export function useSidebarWorkspaceParents(serverIds: string[]): ReadonlyMap<string, string> {
  const parentIndexes = useStoreWithEqualityFn(
    useSessionStore,
    (state) => serverIds.map((serverId) => state.sessions[serverId]?.workspaceParents ?? null),
    shallow,
  );
  return useMemo(() => {
    const parentKeyByWorkspaceKey = new Map<string, string>();
    for (let index = 0; index < serverIds.length; index += 1) {
      const serverId = serverIds[index];
      for (const [workspaceId, parentWorkspaceId] of parentIndexes[index] ?? []) {
        parentKeyByWorkspaceKey.set(
          `${serverId}:${workspaceId}`,
          `${serverId}:${parentWorkspaceId}`,
        );
      }
    }
    return parentKeyByWorkspaceKey.size === 0 ? EMPTY_WORKSPACE_PARENTS : parentKeyByWorkspaceKey;
  }, [parentIndexes, serverIds]);
}
