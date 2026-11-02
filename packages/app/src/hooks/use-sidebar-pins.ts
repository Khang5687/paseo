import { useMemo, useRef } from "react";
import { shallow } from "zustand/shallow";
import { useStoreWithEqualityFn } from "zustand/traditional";
import type {
  SidebarProjectEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
import { applyStoredOrdering } from "@/hooks/sidebar-workspaces-view-model";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";

export interface PinnedSidebarKeys {
  pinnedWorkspaceKeys: string[];
  // workspaceKey -> pinnedAt ISO string, used to order by recency.
  pinnedAtByKey: Record<string, string>;
}

export interface PinnedSidebarGroups {
  // Individually pinned chats, hoisted into the Pinned section and removed from their
  // project below. Most recently pinned first.
  pinnedChats: SidebarWorkspacePlacement[];
  // Everything else, with pinned chats removed. Feeds the draggable project list.
  unpinnedProjects: SidebarProjectEntry[];
}

export function projectWithoutWorkspaces(
  project: SidebarProjectEntry,
  workspaceKeys: ReadonlySet<string>,
): SidebarProjectEntry {
  const workspaces = project.workspaces.filter(
    (workspace) => !workspaceKeys.has(workspace.workspaceKey),
  );
  // Keep the project even when every chat moved to Pinned or Settled. The project row owns
  // its settings and new-workspace actions; chats are not its ownership boundary.
  return workspaces.length === project.workspaces.length ? project : { ...project, workspaces };
}

function buildPinnedSidebarKeys(
  projects: SidebarProjectEntry[],
  workspaceMaps: SidebarWorkspaceMaps<{ pinnedAt?: string | null }>,
): PinnedSidebarKeys {
  const pinnedWorkspaceKeys: string[] = [];
  const pinnedAtByKey: Record<string, string> = {};

  for (const project of projects) {
    for (const placement of project.workspaces) {
      const workspace = workspaceMaps.get(placement.serverId)?.get(placement.workspaceId);
      if (workspace?.pinnedAt) {
        pinnedWorkspaceKeys.push(placement.workspaceKey);
        pinnedAtByKey[placement.workspaceKey] = workspace.pinnedAt;
      }
    }
  }
  return { pinnedWorkspaceKeys, pinnedAtByKey };
}

function arePinnedSidebarKeysEqual(left: PinnedSidebarKeys, right: PinnedSidebarKeys): boolean {
  if (left.pinnedWorkspaceKeys.length !== right.pinnedWorkspaceKeys.length) {
    return false;
  }
  for (let index = 0; index < left.pinnedWorkspaceKeys.length; index += 1) {
    const workspaceKey = left.pinnedWorkspaceKeys[index];
    if (
      workspaceKey !== right.pinnedWorkspaceKeys[index] ||
      (workspaceKey && left.pinnedAtByKey[workspaceKey] !== right.pinnedAtByKey[workspaceKey])
    ) {
      return false;
    }
  }
  return true;
}

export type SidebarWorkspaceMaps<T> = ReadonlyMap<string, ReadonlyMap<string, T>>;

// The session-store workspace maps of every host the given projects draw from, keyed by serverId.
// Pins and settles read their timestamps here rather than from the hydrated sidebar entries,
// which a retained-but-inactive sidebar does not build in project mode.
export function useSidebarWorkspaceMaps(
  projects: SidebarProjectEntry[],
): SidebarWorkspaceMaps<WorkspaceDescriptor> {
  const serverIds = useMemo(
    () =>
      Array.from(
        new Set(
          projects.flatMap((project) => project.workspaces.map((workspace) => workspace.serverId)),
        ),
      ),
    [projects],
  );
  const workspaceMaps = useStoreWithEqualityFn(
    useSessionStore,
    (state) => serverIds.map((serverId) => state.sessions[serverId]?.workspaces ?? null),
    shallow,
  );
  return useMemo(() => {
    const workspaceMapByServerId = new Map<string, ReadonlyMap<string, WorkspaceDescriptor>>();
    for (let index = 0; index < serverIds.length; index += 1) {
      const serverId = serverIds[index];
      const workspaceMap = workspaceMaps[index];
      if (serverId && workspaceMap) {
        workspaceMapByServerId.set(serverId, workspaceMap);
      }
    }
    return workspaceMapByServerId;
  }, [serverIds, workspaceMaps]);
}

export function usePinnedSidebarKeys(projects: SidebarProjectEntry[]): PinnedSidebarKeys {
  const previousKeysRef = useRef<PinnedSidebarKeys>({
    pinnedWorkspaceKeys: [],
    pinnedAtByKey: {},
  });
  const workspaceMaps = useSidebarWorkspaceMaps(projects);
  return useMemo(() => {
    const nextKeys = buildPinnedSidebarKeys(projects, workspaceMaps);
    if (arePinnedSidebarKeysEqual(previousKeysRef.current, nextKeys)) {
      return previousKeysRef.current;
    }
    previousKeysRef.current = nextKeys;
    return nextKeys;
  }, [projects, workspaceMaps]);
}

// Splits the sidebar into a dedicated Pinned section (chats) and the regular list below.
// Pinned chats are ordered most-recently-pinned first.
export function splitPinnedSidebarGroups(input: {
  projects: SidebarProjectEntry[];
  keys: PinnedSidebarKeys;
  pinnedWorkspaceOrder: string[];
}): PinnedSidebarGroups {
  const { projects, keys, pinnedWorkspaceOrder } = input;
  if (keys.pinnedWorkspaceKeys.length === 0) {
    return { pinnedChats: [], unpinnedProjects: projects };
  }
  const pinnedWorkspaceKeySet = new Set(keys.pinnedWorkspaceKeys);
  const pinnedChats: SidebarWorkspacePlacement[] = [];
  const unpinnedProjects: SidebarProjectEntry[] = [];

  for (const project of projects) {
    for (const workspace of project.workspaces) {
      if (pinnedWorkspaceKeySet.has(workspace.workspaceKey)) {
        pinnedChats.push(workspace);
      }
    }
    unpinnedProjects.push(projectWithoutWorkspaces(project, pinnedWorkspaceKeySet));
  }

  pinnedChats.sort((a, b) =>
    (keys.pinnedAtByKey[b.workspaceKey] ?? "").localeCompare(
      keys.pinnedAtByKey[a.workspaceKey] ?? "",
    ),
  );

  return {
    pinnedChats: applyStoredOrdering({
      items: pinnedChats,
      storedOrder: pinnedWorkspaceOrder,
      getKey: (workspace) => workspace.workspaceKey,
    }),
    unpinnedProjects,
  };
}
