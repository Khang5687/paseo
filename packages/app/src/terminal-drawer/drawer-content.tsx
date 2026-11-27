import { useCallback } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { TerminalPane } from "@/components/terminal-pane";
import { useIsCompactFormFactor } from "@/constants/layout";
import { usePaneContext, usePaneFocus } from "@/panels/pane-context";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { showExplorerSidebar } from "@/workspace-tabs/explorer-sidebar";
import { DrawerHeader } from "./drawer-header";
import type { ChatTerminalDrawer } from "./use-chat-terminal-drawer";

/** The header and the active terminal; shared by the desktop dock and the phone sheet. */
export function DrawerContent({
  drawer,
  focused,
  onShowChat,
}: {
  drawer: ChatTerminalDrawer;
  focused: boolean;
  onShowChat?: () => void;
}) {
  const compact = useIsCompactFormFactor();
  const { serverId, workspaceId, openTab, openFileInWorkspace } = usePaneContext();
  const { isWorkspaceFocused, isInteractive } = usePaneFocus();
  const { activeTerminalId, chat, view, closeTerminal, popOut, setMaximized } = drawer;

  const handleCloseActive = useCallback(() => {
    if (activeTerminalId) closeTerminal(activeTerminalId);
  }, [activeTerminalId, closeTerminal]);
  const openTerminalTab = useCallback(
    (terminalId: string) => openTab({ kind: "terminal", terminalId }),
    [openTab],
  );
  const handlePopOutActive = useCallback(() => {
    if (activeTerminalId) void popOut(activeTerminalId, openTerminalTab);
  }, [activeTerminalId, openTerminalTab, popOut]);
  const handleToggleMaximized = useCallback(
    () => setMaximized(!view.maximized),
    [setMaximized, view.maximized],
  );
  const handleOpenFileExplorer = useCallback(() => {
    showExplorerSidebar({
      isCompact: compact,
      workspaceKey: buildWorkspaceTabPersistenceKey({ serverId, workspaceId }),
    });
  }, [compact, serverId, workspaceId]);

  return (
    <View style={styles.content}>
      <DrawerHeader
        terminals={chat.terminals}
        activeTerminalId={activeTerminalId}
        compact={compact}
        isCreating={chat.isCreating}
        maximized={view.maximized}
        onSelect={drawer.select}
        onAdd={drawer.addTerminal}
        onCloseActive={handleCloseActive}
        onPopOutActive={handlePopOutActive}
        onToggleMaximized={handleToggleMaximized}
        onHide={drawer.hide}
        onShowChat={onShowChat}
      />
      <View style={styles.body}>
        {activeTerminalId && chat.workspaceDirectory ? (
          <TerminalPane
            key={activeTerminalId}
            serverId={serverId}
            workspaceId={workspaceId}
            cwd={chat.workspaceDirectory}
            terminalId={activeTerminalId}
            isWorkspaceFocused={isWorkspaceFocused}
            isPaneFocused={isInteractive && focused}
            onOpenFileExplorer={handleOpenFileExplorer}
            onOpenWorkspaceFile={openFileInWorkspace}
            onSwipe={drawer.selectNeighbor}
          />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create(() => ({
  content: {
    flex: 1,
    minHeight: 0,
  },
  body: {
    flex: 1,
    minHeight: 0,
  },
}));
