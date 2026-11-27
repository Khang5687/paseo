import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { View, type LayoutChangeEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ResizeHandle } from "@/components/resize-handle";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import { useKeyboardActionDispatcher } from "@/keyboard/keyboard-action-dispatcher-context";
import { usePaneContext, usePaneFocus } from "@/panels/pane-context";
import { DrawerContent } from "./drawer-content";
import { clampDesktopDrawerHeight, resolveDrawerToggle } from "./model";
import { PhoneTerminalDrawer } from "./phone-drawer";
import { useTerminalDrawerStore } from "./store";
import { useChatTerminalDrawer, type ChatTerminalDrawer } from "./use-chat-terminal-drawer";

/**
 * Wraps a chat with its terminal drawer: docked under the chat on desktop, a bottom sheet on a
 * phone. A draft, a side pane, or a host that cannot tie a terminal to a chat gets the chat
 * alone, inside the same views, so the chat stays mounted when a draft becomes an agent.
 */
export function ChatTerminalDrawerHost({
  agentId,
  children,
}: {
  agentId: string | undefined;
  children: ReactNode;
}) {
  const { serverId, workspaceId, host } = usePaneContext();
  const drawer = useChatTerminalDrawer({ serverId, workspaceId, agentId: agentId ?? "" });
  const enabled = Boolean(agentId) && host === "main" && drawer.chat.supported;
  return (
    <DrawerLayout drawer={drawer} enabled={enabled}>
      {children}
    </DrawerLayout>
  );
}

function DrawerLayout({
  drawer,
  enabled,
  children,
}: {
  drawer: ChatTerminalDrawer;
  enabled: boolean;
  children: ReactNode;
}) {
  const compact = useIsCompactFormFactor();
  const { isInteractive } = usePaneFocus();
  const [focused, setFocused] = useState(false);
  const focusedRef = useRef(false);
  focusedRef.current = focused;
  const dispatcher = useKeyboardActionDispatcher();
  const { show, hide, view, key } = drawer;
  const open = enabled && view.open;

  // A focus request (the header toggle, a new tab) hands the terminal focus once it shows.
  const focusRequest = useTerminalDrawerStore((state) => state.focusRequests[key] ?? 0);
  useEffect(() => {
    if (focusRequest > 0) setFocused(true);
  }, [focusRequest]);
  useEffect(() => {
    if (!open) setFocused(false);
  }, [open]);

  const handleToggle = useCallback(() => {
    const step = resolveDrawerToggle({ open, focused: focusedRef.current });
    if (step === "open") {
      show();
    } else if (step === "focus") {
      setFocused(true);
    } else {
      hide();
      dispatcher.dispatch({ id: "message-input.focus", scope: "message-input" });
    }
    return true;
  }, [dispatcher, hide, open, show]);

  useKeyboardActionHandler({
    handlerId: `terminal-drawer:${key}`,
    actions: ["workspace.terminal.drawer.toggle"],
    enabled: enabled && isInteractive,
    priority: 200,
    handle: handleToggle,
  });

  const handleDrawerFocus = useCallback(() => setFocused(true), []);
  const handleDrawerBlur = useCallback(() => setFocused(false), []);

  if (compact) {
    return (
      <PhoneTerminalDrawer
        drawer={drawer}
        open={open}
        focused={focused}
        onDrawerTouch={handleDrawerFocus}
        onChatTouch={handleDrawerBlur}
      >
        {children}
      </PhoneTerminalDrawer>
    );
  }
  return (
    <DesktopTerminalDrawer
      drawer={drawer}
      open={open}
      focused={focused}
      onFocusIn={handleDrawerFocus}
      onFocusOut={handleDrawerBlur}
    >
      {children}
    </DesktopTerminalDrawer>
  );
}

function DesktopTerminalDrawer({
  drawer,
  open,
  focused,
  onFocusIn,
  onFocusOut,
  children,
}: {
  drawer: ChatTerminalDrawer;
  open: boolean;
  focused: boolean;
  onFocusIn: () => void;
  onFocusOut: () => void;
  children: ReactNode;
}) {
  const desktopHeight = useTerminalDrawerStore((state) => state.desktopHeight);
  const setDesktopHeight = useTerminalDrawerStore((state) => state.setDesktopHeight);
  const [containerHeight, setContainerHeight] = useState(0);
  const [previewHeight, setPreviewHeight] = useState<number | null>(null);
  const maximized = drawer.view.maximized;
  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    setContainerHeight(event.nativeEvent.layout.height);
  }, []);
  const height = clampDesktopDrawerHeight(previewHeight ?? desktopHeight, containerHeight);
  const sizes = useMemo(() => {
    const drawerShare = containerHeight > 0 ? height / containerHeight : 0.5;
    return [1 - drawerShare, drawerShare];
  }, [containerHeight, height]);

  const toHeight = useCallback(
    (nextSizes: number[]) =>
      clampDesktopDrawerHeight((nextSizes[1] ?? 0) * containerHeight, containerHeight),
    [containerHeight],
  );
  const handlePreview = useCallback(
    (_groupId: string, nextSizes: number[]) => setPreviewHeight(toHeight(nextSizes)),
    [toHeight],
  );
  const handleResize = useCallback(
    (_groupId: string, nextSizes: number[]) => {
      setDesktopHeight(toHeight(nextSizes));
      setPreviewHeight(null);
    },
    [setDesktopHeight, toHeight],
  );

  return (
    <View style={styles.root} onLayout={handleLayout}>
      <View style={styles.chat} onTouchStart={onFocusOut}>
        {children}
      </View>
      {open && !maximized ? (
        <ResizeHandle
          direction="vertical"
          groupId="terminal-drawer"
          index={0}
          sizes={sizes}
          containerSize={containerHeight}
          onResizeSplit={handleResize}
          onPreviewResizeSplit={handlePreview}
          testID="terminal-drawer-resize"
        />
      ) : null}
      {open ? (
        <View
          style={maximized ? styles.desktopDrawerMaximized : [styles.desktopDrawer, { height }]}
          onFocus={onFocusIn}
          onBlur={onFocusOut}
          testID="terminal-drawer"
        >
          <DrawerContent drawer={drawer} focused={focused} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    minHeight: 0,
  },
  chat: {
    flex: 1,
    minHeight: 0,
  },
  desktopDrawer: {
    flexShrink: 0,
    backgroundColor: theme.colors.surface0,
  },
  desktopDrawerMaximized: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: theme.colors.surface0,
  },
}));
