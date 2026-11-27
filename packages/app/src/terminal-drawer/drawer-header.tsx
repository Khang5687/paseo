import { useCallback } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ExternalLink,
  Maximize2,
  MessageSquare,
  Minimize2,
  Plus,
  Trash2,
} from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { ToolbarButton, paneContentToolbarIconSize } from "@/components/ui/pane-content-toolbar";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { PressHighlight } from "@/components/ui/press-highlight";
import type { DrawerTerminal } from "./model";

const ThemedPlus = withUnistyles(Plus);
const ThemedTrash = withUnistyles(Trash2);
const ThemedPopOut = withUnistyles(ExternalLink);
const ThemedMaximize = withUnistyles(Maximize2);
const ThemedMinimize = withUnistyles(Minimize2);
const ThemedHide = withUnistyles(ChevronDown);

function DrawerTab({
  terminal,
  index,
  active,
  onSelect,
}: {
  terminal: DrawerTerminal;
  index: number;
  active: boolean;
  onSelect: (terminalId: string) => void;
}) {
  const { t } = useTranslation();
  // The host's name ("Terminal 3") stays put when another tab closes; a shell title wins over it.
  const label =
    terminal.title?.trim() || terminal.name || t("terminalDrawer.tabTitle", { index: index + 1 });
  const handlePress = useCallback(() => onSelect(terminal.id), [onSelect, terminal.id]);
  return (
    <PressHighlight
      accessibilityRole="tab"
      accessibilityState={active ? SELECTED : UNSELECTED}
      onPress={handlePress}
      style={[styles.tab, active && styles.tabActive]}
      highlightStyle={styles.tabPressed}
      testID={`terminal-drawer-tab-${terminal.id}`}
    >
      <Text numberOfLines={1} style={[styles.tabLabel, active && styles.tabLabelActive]}>
        {label}
      </Text>
    </PressHighlight>
  );
}

const SELECTED = { selected: true };
const UNSELECTED = { selected: false };

export interface DrawerHeaderProps {
  terminals: DrawerTerminal[];
  activeTerminalId: string | null;
  compact: boolean;
  isCreating: boolean;
  maximized: boolean;
  onSelect: (terminalId: string) => void;
  onAdd: () => void;
  onCloseActive: () => void;
  onPopOutActive: () => void;
  onToggleMaximized: () => void;
  onHide: () => void;
  /** Phone full screen only: jump to the chat, leaving the terminal one tap away. */
  onShowChat?: () => void;
}

/** Tabs for the chat's terminals and the drawer's actions, in one row. */
export function DrawerHeader({
  terminals,
  activeTerminalId,
  compact,
  isCreating,
  maximized,
  onSelect,
  onAdd,
  onCloseActive,
  onPopOutActive,
  onToggleMaximized,
  onHide,
  onShowChat,
}: DrawerHeaderProps) {
  const { t } = useTranslation();
  const iconSize = paneContentToolbarIconSize(compact);
  const hasActive = activeTerminalId !== null;
  return (
    <View style={styles.header}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.tabs}
        contentContainerStyle={styles.tabsContent}
      >
        {terminals.map((terminal, index) => (
          <DrawerTab
            key={terminal.id}
            terminal={terminal}
            index={index}
            active={terminal.id === activeTerminalId}
            onSelect={onSelect}
          />
        ))}
        <ToolbarButton
          label={t("terminalDrawer.newTerminal")}
          onPress={onAdd}
          disabled={isCreating}
          compact={compact}
          testID="terminal-drawer-new"
        >
          <ThemedPlus size={iconSize} uniProps={mutedIconColorMapping} />
        </ToolbarButton>
      </ScrollView>
      <View style={styles.actions}>
        {onShowChat ? (
          <Button
            variant="outline"
            size="sm"
            leftIcon={MessageSquare}
            onPress={onShowChat}
            testID="terminal-drawer-show-chat"
          >
            {t("terminalDrawer.backToChat")}
          </Button>
        ) : null}
        {compact ? null : (
          <ToolbarButton
            label={maximized ? t("terminalDrawer.restore") : t("terminalDrawer.maximize")}
            onPress={onToggleMaximized}
            selected={maximized}
            testID="terminal-drawer-maximize"
          >
            {maximized ? (
              <ThemedMinimize size={iconSize} uniProps={mutedIconColorMapping} />
            ) : (
              <ThemedMaximize size={iconSize} uniProps={mutedIconColorMapping} />
            )}
          </ToolbarButton>
        )}
        <ToolbarButton
          label={t("terminalDrawer.popOut")}
          onPress={onPopOutActive}
          disabled={!hasActive}
          compact={compact}
          testID="terminal-drawer-pop-out"
        >
          <ThemedPopOut size={iconSize} uniProps={mutedIconColorMapping} />
        </ToolbarButton>
        <ToolbarButton
          label={t("terminalDrawer.closeTerminal")}
          onPress={onCloseActive}
          disabled={!hasActive}
          compact={compact}
          testID="terminal-drawer-kill"
        >
          <ThemedTrash size={iconSize} uniProps={mutedIconColorMapping} />
        </ToolbarButton>
        <ToolbarButton
          label={t("terminalDrawer.hide")}
          onPress={onHide}
          compact={compact}
          testID="terminal-drawer-hide"
        >
          <ThemedHide size={iconSize} uniProps={mutedIconColorMapping} />
        </ToolbarButton>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  header: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 36,
    paddingLeft: theme.spacing[2],
    paddingRight: theme.spacing[1],
    gap: theme.spacing[1],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  tabs: {
    flex: 1,
    minWidth: 0,
  },
  tabsContent: {
    alignItems: "center",
    gap: theme.spacing[1],
  },
  tab: {
    maxWidth: 180,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  tabActive: {
    backgroundColor: theme.colors.surface2,
  },
  tabPressed: {
    backgroundColor: theme.colors.surface1,
  },
  tabLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  tabLabelActive: {
    color: theme.colors.foreground,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
}));
