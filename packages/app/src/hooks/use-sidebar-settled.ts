import { useMemo, useRef } from "react";
import type {
  SidebarProjectEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
import {
  projectWithoutWorkspaces,
  useSidebarWorkspaceMaps,
  type SidebarWorkspaceMaps,
} from "@/hooks/use-sidebar-pins";

export interface SettledSidebarKeys {
  settledWorkspaceKeys: string[];
  // workspaceKey -> settledAt ISO string, used to order by recency.
  settledAtByKey: Record<string, string>;
}

export interface SettledSidebarGroups {
  // Settled workspaces, moved into the Settled section at the bottom of the list. Most recently
  // settled first.
  settledRows: SidebarWorkspacePlacement[];
  // The given projects with their settled workspaces removed.
  unsettledProjects: SidebarProjectEntry[];
}

function buildSettledSidebarKeys(
  projects: SidebarProjectEntry[],
  workspaceMaps: SidebarWorkspaceMaps<{ pinnedAt?: string | null; settledAt?: string | null }>,
): SettledSidebarKeys {
  const settledWorkspaceKeys: string[] = [];
  const settledAtByKey: Record<string, string> = {};

  for (const project of projects) {
    for (const placement of project.workspaces) {
      const workspace = workspaceMaps.get(placement.serverId)?.get(placement.workspaceId);
      // Pinned wins: a pinned workspace stays in Pinned whatever its settle state.
      if (workspace?.settledAt && !workspace.pinnedAt) {
        settledWorkspaceKeys.push(placement.workspaceKey);
        settledAtByKey[placement.workspaceKey] = workspace.settledAt;
      }
    }
  }
  return { settledWorkspaceKeys, settledAtByKey };
}

function areSettledSidebarKeysEqual(left: SettledSidebarKeys, right: SettledSidebarKeys): boolean {
  if (left.settledWorkspaceKeys.length !== right.settledWorkspaceKeys.length) {
    return false;
  }
  for (let index = 0; index < left.settledWorkspaceKeys.length; index += 1) {
    const workspaceKey = left.settledWorkspaceKeys[index];
    if (
      workspaceKey !== right.settledWorkspaceKeys[index] ||
      (workspaceKey && left.settledAtByKey[workspaceKey] !== right.settledAtByKey[workspaceKey])
    ) {
      return false;
    }
  }
  return true;
}

export function useSettledSidebarKeys(projects: SidebarProjectEntry[]): SettledSidebarKeys {
  const previousKeysRef = useRef<SettledSidebarKeys>({
    settledWorkspaceKeys: [],
    settledAtByKey: {},
  });
  const workspaceMaps = useSidebarWorkspaceMaps(projects);
  return useMemo(() => {
    const nextKeys = buildSettledSidebarKeys(projects, workspaceMaps);
    if (areSettledSidebarKeysEqual(previousKeysRef.current, nextKeys)) {
      return previousKeysRef.current;
    }
    previousKeysRef.current = nextKeys;
    return nextKeys;
  }, [projects, workspaceMaps]);
}

// Splits settled workspaces out of the list into the flat Settled section. Runs after the pinned
// split, so a workspace already hoisted into Pinned is never also settled.
export function splitSettledSidebarGroups(input: {
  projects: SidebarProjectEntry[];
  keys: SettledSidebarKeys;
}): SettledSidebarGroups {
  const { projects, keys } = input;
  if (keys.settledWorkspaceKeys.length === 0) {
    return { settledRows: [], unsettledProjects: projects };
  }
  const settledWorkspaceKeySet = new Set(keys.settledWorkspaceKeys);
  const settledRows: SidebarWorkspacePlacement[] = [];
  const unsettledProjects: SidebarProjectEntry[] = [];

  for (const project of projects) {
    for (const workspace of project.workspaces) {
      if (settledWorkspaceKeySet.has(workspace.workspaceKey)) {
        settledRows.push(workspace);
      }
    }
    unsettledProjects.push(projectWithoutWorkspaces(project, settledWorkspaceKeySet));
  }

  settledRows.sort(
    (a, b) =>
      (keys.settledAtByKey[b.workspaceKey] ?? "").localeCompare(
        keys.settledAtByKey[a.workspaceKey] ?? "",
      ) || a.workspaceKey.localeCompare(b.workspaceKey),
  );

  return { settledRows, unsettledProjects };
}
