import { useMemo } from "react";
import { type JumpTarget, resolveWaitingWorkspaces } from "@/components/sidebar/jump-targets";
import { useSidebarModel } from "@/components/sidebar/sidebar-model";

/** Workspaces waiting on you in every project, filters aside, the one that waited longest first. */
export function useWaitingWorkspaces(): JumpTarget[] {
  const { allWorkspaceEntriesByKey } = useSidebarModel();
  return useMemo(
    () => resolveWaitingWorkspaces(allWorkspaceEntriesByKey.values()),
    [allWorkspaceEntriesByKey],
  );
}
