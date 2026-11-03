import { i18n } from "@/i18n/i18next";
import { confirmDialog, type ConfirmDialogInput } from "@/utils/confirm-dialog";

export type ArchiveConfirmSubject = "agent" | "workspace" | "finishedSubagents";

export interface ArchiveConfirmInput {
  subject: ArchiveConfirmSubject;
  /** Title of the agent or name of the workspace; blank falls back to a generic title. */
  name?: string | null;
  /** For `finishedSubagents`: how many will be archived, when the caller knows. */
  count?: number;
}

/**
 * The one confirmation every UI archive entry point shows before archiving. Archive is a soft
 * delete, so the message points at History instead of warning about data loss.
 */
export function buildArchiveConfirmDialog(input: ArchiveConfirmInput): ConfirmDialogInput {
  const name = input.name?.trim() ?? "";
  let title: string;
  if (input.subject === "finishedSubagents") {
    if (input.count === undefined) {
      title = i18n.t("archiveConfirm.finishedSubagentsTitle");
    } else {
      title = i18n.t(
        input.count === 1
          ? "archiveConfirm.finishedSubagentsCountOne"
          : "archiveConfirm.finishedSubagentsCountMany",
        { count: input.count },
      );
    }
  } else if (input.subject === "agent") {
    title = name
      ? i18n.t("archiveConfirm.agentTitle", { name })
      : i18n.t("archiveConfirm.agentTitleUnnamed");
  } else {
    title = name
      ? i18n.t("archiveConfirm.workspaceTitle", { name })
      : i18n.t("archiveConfirm.workspaceTitleUnnamed");
  }
  return {
    title,
    message: i18n.t("archiveConfirm.message"),
    confirmLabel: i18n.t("archiveConfirm.confirm"),
    cancelLabel: i18n.t("archiveConfirm.cancel"),
    destructive: true,
  };
}

export function confirmArchive(input: ArchiveConfirmInput): Promise<boolean> {
  return confirmDialog(buildArchiveConfirmDialog(input));
}

/**
 * Confirmation for archiving an agent by closing its tab. A running agent gets the stronger
 * warning because archiving stops it.
 */
export function confirmArchiveAgentTab(
  agent: { title?: string | null; status?: string | null } | null,
): Promise<boolean> {
  if (agent?.status === "running") {
    return confirmDialog({
      title: i18n.t("workspace.tabs.confirmations.archiveRunningAgentTitle"),
      message: i18n.t("workspace.tabs.confirmations.archiveRunningAgentMessage"),
      confirmLabel: i18n.t("workspace.tabs.confirmations.archive"),
      cancelLabel: i18n.t("workspace.tabs.confirmations.cancel"),
      destructive: true,
    });
  }
  return confirmArchive({ subject: "agent", name: agent?.title });
}
