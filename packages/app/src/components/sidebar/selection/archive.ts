import {
  buildWorktreeArchiveRiskReasons,
  toWorktreeArchiveRisk,
} from "@/git/worktree-archive-warning";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import type { ActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { redirectIfArchivingActiveWorkspace } from "@/utils/sidebar-workspace-archive-redirect";
import { purgeArchivedWorkspaceState } from "@/workspace/use-workspace-archive";
import {
  archiveWorkspacesOptimistically,
  type WorkspaceArchiveFailure,
} from "@/workspace/workspace-archive";

export type SidebarArchiveEntry = Pick<
  SidebarWorkspaceEntry,
  | "serverId"
  | "workspaceId"
  | "workspaceKind"
  | "name"
  | "archiveHasUncommittedChanges"
  | "archiveUnpushedCommitCount"
  | "diffStat"
>;

/**
 * One line per workspace for the single confirm that stands in for each row's own. A worktree
 * carries the reasons its row's Archive would have warned about, so asking once loses nothing.
 */
export function buildSidebarArchiveMessage(workspaces: readonly SidebarArchiveEntry[]): string {
  return workspaces
    .map((workspace) => {
      const reasons =
        workspace.workspaceKind === "worktree"
          ? buildWorktreeArchiveRiskReasons(toWorktreeArchiveRisk(workspace))
          : [];
      return reasons.length > 0 ? `${workspace.name}: ${reasons.join(", ")}` : workspace.name;
    })
    .join("\n");
}

/**
 * The steps a row's own Archive takes, for many rows: leave the open workspace first, hide every
 * row optimistically, archive on the host, then drop the archived workspaces' saved tabs. A row
 * that fails comes back on its own; the caller reports the failures.
 */
export async function archiveSidebarWorkspaces(input: {
  workspaces: readonly SidebarArchiveEntry[];
  activeWorkspaceSelection: ActiveWorkspaceSelection | null;
}): Promise<WorkspaceArchiveFailure[]> {
  const targets = input.workspaces.map((workspace) => ({
    serverId: workspace.serverId,
    workspaceId: workspace.workspaceId,
  }));
  for (const target of targets) {
    redirectIfArchivingActiveWorkspace({
      ...target,
      activeWorkspaceSelection: input.activeWorkspaceSelection,
    });
  }

  const failures = await archiveWorkspacesOptimistically({
    getClient: (serverId) => getHostRuntimeStore().getClient(serverId),
    workspaces: targets,
  });
  const failedKeys = new Set(
    failures.map((failure) => `${failure.serverId}:${failure.workspaceId}`),
  );
  for (const target of targets) {
    if (!failedKeys.has(`${target.serverId}:${target.workspaceId}`)) {
      purgeArchivedWorkspaceState(target);
    }
  }
  return failures;
}
