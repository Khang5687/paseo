import { useTranslation } from "react-i18next";
import { withUnistyles } from "react-native-unistyles";
import { Archive } from "lucide-react-native";
import { isWeb } from "@/constants/platform";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { renderTriggerIcon, triggerStyle } from "@/components/sidebar/sidebar-workspace-menu";
import type { ArchiveFinishedStatus } from "@/subagents/use-archive-finished";
import type { Theme } from "@/styles/theme";

const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
const ThemedArchive = withUnistyles(Archive);
const archiveLeadingIcon = <ThemedArchive size={14} uniProps={foregroundMutedColorMapping} />;

/**
 * Kebab on a thread's "N subagents" fold row: the one bulk action for the whole subagent tree.
 * A tap target on every layout, because the fold row has no hover-only affordances to fall back on.
 */
export function SidebarThreadChildrenMenu({
  workspaceKey,
  finishedCount,
  status,
  onArchiveFinished,
  open,
  onOpenChange,
}: {
  workspaceKey: string;
  finishedCount: number;
  status: ArchiveFinishedStatus;
  onArchiveFinished: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const archiving = status.kind === "archiving";
  let label = t("subagents.archiveFinishedCountAction", { count: finishedCount });
  if (status.kind === "archiving") {
    label = t("subagents.archiveFinishedProgress", {
      completed: status.completedCount,
      total: status.totalCount,
    });
  } else if (status.kind === "failed") {
    label = t("subagents.archiveFinishedRetry", {
      failed: status.failedCount,
      total: status.totalCount,
    });
  }
  return (
    <DropdownMenu compactMode="sheet" open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        hitSlop={8}
        style={triggerStyle}
        accessibilityRole={isWeb ? undefined : "button"}
        accessibilityLabel={t("sidebar.workspace.actions.menu")}
        testID={`sidebar-thread-children-kebab-${workspaceKey}`}
      >
        {renderTriggerIcon}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={260} sheetTitle={t("subagents.title")}>
        <DropdownMenuItem
          testID={`sidebar-thread-children-archive-finished-${workspaceKey}`}
          leading={archiveLeadingIcon}
          disabled={archiving}
          onSelect={onArchiveFinished}
        >
          {label}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
