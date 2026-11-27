import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { SquareTerminal } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { HeaderToggleButton } from "@/components/headers/header-toggle-button";
import {
  extraMutedIconColorMapping,
  iconButtonChromeGlyphSize,
  mutedIconColorMapping,
} from "@/components/ui/icon-button-chrome";
import type { ShortcutKey } from "@/utils/format-shortcut";
import { useChatTerminalDrawer } from "./use-chat-terminal-drawer";

const ThemedTerminalIcon = withUnistyles(SquareTerminal);
const DRAWER_TOGGLE_KEYS: ShortcutKey[] = ["ctrl", "J"];

/** The header button that shows or hides the focused chat's terminal drawer. */
export function ChatTerminalDrawerToggle({
  serverId,
  workspaceId,
  agentId,
  mobile,
}: {
  serverId: string;
  workspaceId: string;
  agentId: string;
  mobile: boolean;
}) {
  const { t } = useTranslation();
  const drawer = useChatTerminalDrawer({ serverId, workspaceId, agentId });
  const { show, hide } = drawer;
  const open = drawer.view.open;
  const handlePress = useCallback(() => (open ? hide() : show()), [hide, open, show]);
  const accessibilityState = useMemo(() => ({ expanded: open }), [open]);
  if (!drawer.chat.supported) return null;
  return (
    <HeaderToggleButton
      testID="terminal-drawer-toggle"
      onPress={handlePress}
      tooltipLabel={t("settings.shortcuts.help.toggleChatTerminal")}
      tooltipKeys={DRAWER_TOGGLE_KEYS}
      tooltipSide="bottom"
      accessible
      accessibilityRole="button"
      accessibilityLabel={open ? t("terminalDrawer.hide") : t("terminalDrawer.show")}
      accessibilityState={accessibilityState}
    >
      <ThemedTerminalIcon
        size={iconButtonChromeGlyphSize("large")}
        strokeWidth={1.5}
        uniProps={mobile || open ? mutedIconColorMapping : extraMutedIconColorMapping}
      />
    </HeaderToggleButton>
  );
}
