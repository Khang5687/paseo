import { useTranslation } from "react-i18next";
import type { PressableStateCallbackType } from "react-native";
import { withUnistyles } from "react-native-unistyles";
import { Copy } from "lucide-react-native";
import {
  SidebarWorkspaceIconButton,
  sidebarIconButtonActiveProps,
  sidebarIconButtonProps,
} from "@/components/sidebar/sidebar-workspace-icon-button";
import { useCopyThreadAgentId } from "@/hooks/use-copy-agent-id";

const ThemedCopy = withUnistyles(Copy);

export function renderCopyAgentIdIcon({
  hovered,
  pressed,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return (
    <ThemedCopy
      uniProps={hovered || pressed ? sidebarIconButtonActiveProps : sidebarIconButtonProps}
    />
  );
}

/**
 * One-press "Copy agent ID" beside the row's Archive button, shown wherever the kebab is. Renders
 * nothing while the row's workspace has no agent to copy.
 */
export function SidebarWorkspaceCopyAgentIdButton({
  workspaceKey,
  serverId,
  workspaceId,
}: {
  workspaceKey: string;
  serverId: string;
  workspaceId: string;
}) {
  const { t } = useTranslation();
  const copy = useCopyThreadAgentId(serverId, workspaceId);
  if (!copy) return null;
  return (
    <SidebarWorkspaceIconButton
      renderIcon={renderCopyAgentIdIcon}
      label={t("sidebar.workspace.actions.copyAgentId")}
      onPress={copy}
      testID={`sidebar-workspace-copy-agent-id-${workspaceKey}`}
    />
  );
}
