import { isNative } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
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
 * including the confirmation dialog. It exists only where there is hover (desktop): on phones
 * and tablets in the compact layout a stray tap on an always-visible icon would archive a
 * thread, so Archive lives in the kebab and long-press menu there.
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
  const isCompact = useIsCompactFormFactor();
  if (isNative || isCompact) {
    return null;
  }
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
