import { useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useToast } from "@/contexts/toast-context";
import {
  buildWorktreeArchiveConfirmationMessage,
  confirmRiskyWorktreeArchive,
  DEFAULT_WORKTREE_ARCHIVE_WARNING_LABELS,
  readWorktreeArchiveRisk,
  type WorktreeArchiveWarningLabels,
} from "@/git/worktree-archive-warning";
import { confirmArchive } from "@/utils/archive-confirm";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { archiveWorkspaceWithUndo, supportsWorkspaceArchiveUndo } from "@/workspace/archive-undo";
import {
  archiveWorkspaceOptimistically,
  runWorkspaceArchiveAttempt,
  type WorkspaceArchiveTarget,
} from "@/workspace/workspace-archive";

export function purgeArchivedWorkspaceState(input: {
  serverId: string;
  workspaceId: string;
}): void {
  const workspaceKey = buildWorkspaceTabPersistenceKey(input);
  if (workspaceKey) {
    useWorkspaceLayoutStore.getState().purgeWorkspace(workspaceKey);
  }
}

export interface ArchiveWorkspaceInput {
  serverId: string;
  workspaceId: string;
  workspaceKind: WorkspaceDescriptor["workspaceKind"];
  workspaceDirectory: string;
  name: string;
  /** Labels the warning's line counts. Whether to warn comes from the host's git state. */
  diffStat?: { additions: number; deletions: number } | null;
  warningLabels?: WorktreeArchiveWarningLabels;
  /** Runs once the archive starts, with the workspace being archived. */
  onArchiveStarted: (workspace: WorkspaceArchiveTarget) => void;
  onSetHiding?: (hiding: boolean) => void;
}

export interface WorkspaceArchiveController {
  archive: () => void;
}

export function useWorkspaceArchive(input: ArchiveWorkspaceInput): WorkspaceArchiveController {
  const {
    serverId,
    workspaceId,
    workspaceKind,
    workspaceDirectory,
    name,
    diffStat,
    warningLabels = DEFAULT_WORKTREE_ARCHIVE_WARNING_LABELS,
    onArchiveStarted,
    onSetHiding,
  } = input;
  const { t } = useTranslation();
  const toast = useToast();
  // The archive starts after the host answers and you confirm. By then you may have opened another
  // workspace, so the redirect reads the selection from the latest render.
  const onArchiveStartedRef = useRef(onArchiveStarted);
  onArchiveStartedRef.current = onArchiveStarted;

  const archiveWorkspaceRecord = useCallback(async () => {
    const client = getHostRuntimeStore().getClient(serverId);
    if (!client) {
      toast.error(t("sidebar.workspace.toasts.hostDisconnected"));
      return;
    }
    const workspace = { serverId, workspaceId };
    onSetHiding?.(true);
    try {
      onArchiveStartedRef.current(workspace);
      if (supportsWorkspaceArchiveUndo(serverId)) {
        await archiveWorkspaceWithUndo({
          client,
          workspace,
          toast,
          onArchiveCommitted: () => purgeArchivedWorkspaceState(workspace),
        });
      } else {
        // COMPAT(workspaceArchiveUndo): hosts before v0.15.3 cannot undo; remove after 2027-05-06.
        await archiveWorkspaceOptimistically({ client, workspace });
        purgeArchivedWorkspaceState(workspace);
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("sidebar.workspace.toasts.archiveFailed"),
      );
    } finally {
      onSetHiding?.(false);
    }
  }, [onSetHiding, serverId, t, toast, workspaceId]);

  // The host removes a worktree it archives, uncommitted work included. Ask it what that would
  // lose: the sidebar row's git status is empty until the row receives it.
  const confirmWorktreeArchive = useCallback(async (): Promise<boolean> => {
    const client = getHostRuntimeStore().getClient(serverId);
    if (!client) {
      toast.error(t("sidebar.workspace.toasts.hostDisconnected"));
      return false;
    }
    const risk = await readWorktreeArchiveRisk(client, workspaceDirectory).catch(
      (error: unknown) => {
        toast.error(
          error instanceof Error ? error.message : t("sidebar.workspace.toasts.archiveFailed"),
        );
        return null;
      },
    );
    if (!risk) {
      return false;
    }
    const confirmation = { workspaceName: name, diffStat, ...risk };
    // A risky worktree gets its own warning; a clean one gets the plain confirmation.
    if (buildWorktreeArchiveConfirmationMessage(confirmation, warningLabels) === null) {
      return await confirmArchive({ subject: "workspace", name });
    }
    return await confirmRiskyWorktreeArchive(confirmation, warningLabels);
  }, [diffStat, name, serverId, t, toast, warningLabels, workspaceDirectory]);

  const archive = useCallback(() => {
    // Every archive asks first: a worktree after its host reports what removing it would lose.
    void runWorkspaceArchiveAttempt({
      workspace: { serverId, workspaceId },
      confirm:
        workspaceKind === "worktree"
          ? confirmWorktreeArchive
          : () => confirmArchive({ subject: "workspace", name }),
      archive: archiveWorkspaceRecord,
    });
  }, [archiveWorkspaceRecord, confirmWorktreeArchive, name, serverId, workspaceId, workspaceKind]);

  return {
    archive,
  };
}
