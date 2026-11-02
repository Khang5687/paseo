import { useTranslation } from "react-i18next";
import type { PressableStateCallbackType } from "react-native";
import { withUnistyles } from "react-native-unistyles";
import { Check } from "lucide-react-native";
import {
  SidebarWorkspaceIconButton,
  sidebarIconButtonActiveProps,
  sidebarIconButtonProps,
} from "@/components/sidebar/sidebar-workspace-icon-button";

const ThemedCheck = withUnistyles(Check);

function renderIcon({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) {
  return (
    <ThemedCheck
      uniProps={hovered || pressed ? sidebarIconButtonActiveProps : sidebarIconButtonProps}
    />
  );
}

/**
 * One-press Archive beside the row's kebab. It runs the same action as the menu's Archive item,
 * including the worktree confirmation when the row's git state shows uncommitted or unpushed
 * work. It appears wherever the kebab does: on hover on desktop, and permanently on touch,
 * where there is no hover.
 */
export function SidebarWorkspaceArchiveButton({
  workspaceKey,
  pending,
  onArchive,
}: {
  workspaceKey: string;
  pending: boolean;
  onArchive: () => void;
}) {
  const { t } = useTranslation();
  return (
    <SidebarWorkspaceIconButton
      renderIcon={renderIcon}
      label={t("sidebar.workspace.actions.archiveWorkspace")}
      disabled={pending}
      onPress={onArchive}
      testID={`sidebar-workspace-archive-${workspaceKey}`}
    />
  );
}
