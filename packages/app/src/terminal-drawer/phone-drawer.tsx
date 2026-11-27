import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Text, View, type LayoutChangeEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useTranslation } from "react-i18next";
import { ChevronUp, SquareTerminal } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useStreamTopOverlayInset } from "@/agent-stream/top-overlay";
import { Button } from "@/components/ui/button";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useKeyboardShift } from "@/keyboard/shift";
import { usePaneContext } from "@/panels/pane-context";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { ICON_SIZE } from "@/styles/theme";
import { DrawerContent } from "./drawer-content";
import {
  lastPrintedLine,
  PHONE_DRAWER_BAR_HEIGHT,
  phoneDrawerSnapHeight,
  settlePhoneDrawerDrag,
  type PhoneDrawerSnap,
} from "./model";
import type { ChatTerminalDrawer } from "./use-chat-terminal-drawer";

const ThemedTerminalIcon = withUnistyles(SquareTerminal);
const ThemedExpand = withUnistyles(ChevronUp);
const SNAP_ANIMATION = { duration: 220 };
const BAR_POLL_MS = 2000;
const FLOATING_BUTTON_GAP = 8;

/**
 * The phone drawer: a bottom sheet over the chat. Half height shows both; drag up for a full
 * screen terminal, down to a thin bar with the last output line. From full screen, Chat sends
 * the terminal behind the chat and a Terminal button brings it back, so one shows at a time.
 */
export function PhoneTerminalDrawer({
  drawer,
  open,
  focused,
  onDrawerTouch,
  onChatTouch,
  children,
}: {
  drawer: ChatTerminalDrawer;
  open: boolean;
  focused: boolean;
  onDrawerTouch: () => void;
  onChatTouch: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const { view, setPhoneSnap } = drawer;
  const [containerHeight, setContainerHeight] = useState(0);
  const snap: PhoneDrawerSnap | null = open ? view.phoneSnap : null;
  const sheetHeight = useSharedValue(0);
  const dragStartHeight = useSharedValue(0);

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    setContainerHeight(event.nativeEvent.layout.height);
  }, []);

  useEffect(() => {
    const target =
      snap === null || snap === "chat" ? 0 : phoneDrawerSnapHeight(snap, containerHeight);
    sheetHeight.value = withTiming(target, SNAP_ANIMATION);
  }, [containerHeight, sheetHeight, snap]);

  // The composer rides up with the keyboard. With the sheet at half height there is no room for
  // both, so the side the person touched last keeps the screen: the terminal goes full screen,
  // the chat folds the terminal to its bar.
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const snapRef = useRef(snap);
  snapRef.current = snap;
  const handleKeyboardShown = useCallback(() => {
    if (snapRef.current !== "half") return;
    setPhoneSnap(focusedRef.current ? "full" : "bar");
  }, [setPhoneSnap]);
  const { layoutShift } = useKeyboardShift();
  useAnimatedReaction(
    () => layoutShift.value > 0,
    (shown, previous) => {
      if (shown && previous === false) scheduleOnRN(handleKeyboardShown);
    },
    [handleKeyboardShown],
  );

  const dragFrom = snap === "bar" || snap === "full" ? snap : "half";
  const dragGesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetY([-8, 8])
        .onStart(() => {
          dragStartHeight.value = sheetHeight.value;
        })
        .onUpdate((event) => {
          const next = dragStartHeight.value - event.translationY;
          sheetHeight.value = Math.min(containerHeight, Math.max(PHONE_DRAWER_BAR_HEIGHT, next));
        })
        .onEnd((event) => {
          const settled = settlePhoneDrawerDrag({
            from: dragFrom,
            height: sheetHeight.value,
            velocityY: event.velocityY,
            containerHeight,
          });
          sheetHeight.value = withTiming(
            phoneDrawerSnapHeight(settled, containerHeight),
            SNAP_ANIMATION,
          );
          scheduleOnRN(setPhoneSnap, settled);
        }),
    [containerHeight, dragFrom, dragStartHeight, setPhoneSnap, sheetHeight],
  );
  const sheetStyle = useAnimatedStyle(() => ({ height: sheetHeight.value }));
  let chatInset = 0;
  if (snap === "bar") {
    chatInset = PHONE_DRAWER_BAR_HEIGHT;
  } else if (snap === "half" || snap === "full") {
    // Full screen covers the chat; it keeps its half-height layout underneath.
    chatInset = phoneDrawerSnapHeight("half", containerHeight);
  }

  const topOverlayInset = useStreamTopOverlayInset();
  const handleShowChat = useCallback(() => setPhoneSnap("chat"), [setPhoneSnap]);
  const handleShowTerminal = useCallback(() => setPhoneSnap("full"), [setPhoneSnap]);
  const handleExpand = useCallback(() => setPhoneSnap("half"), [setPhoneSnap]);

  return (
    <View style={styles.root} onLayout={handleLayout}>
      <View style={[styles.chat, { paddingBottom: chatInset }]} onTouchStart={onChatTouch}>
        {children}
      </View>
      {snap === "chat" ? (
        <Button
          variant="outline"
          size="sm"
          leftIcon={SquareTerminal}
          onPress={handleShowTerminal}
          style={[styles.floatingButton, { top: topOverlayInset + FLOATING_BUTTON_GAP }]}
          testID="terminal-drawer-show-terminal"
        >
          {t("terminalDrawer.backToTerminal")}
        </Button>
      ) : null}
      {snap !== null && snap !== "chat" ? (
        <Animated.View
          style={[styles.sheet, sheetStyle]}
          onTouchStart={onDrawerTouch}
          testID="terminal-drawer"
        >
          <GestureDetector gesture={dragGesture}>
            <View testID="terminal-drawer-grabber">
              <View style={styles.grabberArea}>
                <View style={styles.grabber} />
              </View>
              {snap === "bar" ? <DrawerBar drawer={drawer} onExpand={handleExpand} /> : null}
            </View>
          </GestureDetector>
          {snap === "bar" ? null : (
            <View style={styles.content}>
              <DrawerContent
                drawer={drawer}
                focused={focused}
                onShowChat={snap === "full" ? handleShowChat : undefined}
              />
            </View>
          )}
        </Animated.View>
      ) : null}
    </View>
  );
}

/** The folded sheet: the active terminal's last printed line. Tap or drag up to open it. */
function DrawerBar({ drawer, onExpand }: { drawer: ChatTerminalDrawer; onExpand: () => void }) {
  const { t } = useTranslation();
  const { serverId } = usePaneContext();
  const client = useHostRuntimeClient(serverId);
  const terminalId = drawer.activeTerminalId;
  const [line, setLine] = useState("");

  useEffect(() => {
    if (!client || !terminalId) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const payload = await client.captureTerminal(terminalId, { start: -60, stripAnsi: true });
        if (!cancelled) setLine(lastPrintedLine(payload.lines));
      } catch {
        // The bar keeps its last line; the next poll tries again.
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), BAR_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client, terminalId]);

  return (
    <PressHighlight
      accessibilityRole="button"
      accessibilityLabel={t("terminalDrawer.expand")}
      onPress={onExpand}
      style={styles.bar}
      testID="terminal-drawer-bar"
    >
      <ThemedTerminalIcon size={ICON_SIZE.sm} uniProps={mutedIconColorMapping} />
      <Text numberOfLines={1} style={styles.barLine}>
        {line || t("terminalDrawer.noOutput")}
      </Text>
      <ThemedExpand size={ICON_SIZE.md} uniProps={mutedIconColorMapping} />
    </PressHighlight>
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
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    overflow: "hidden",
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    borderTopLeftRadius: theme.borderRadius.lg,
    borderTopRightRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface0,
  },
  grabberArea: {
    height: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  grabber: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.colors.foregroundExtraMuted,
  },
  content: {
    flex: 1,
    minHeight: 0,
  },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    height: PHONE_DRAWER_BAR_HEIGHT - 16,
    paddingHorizontal: theme.spacing[3],
  },
  barLine: {
    flex: 1,
    minWidth: 0,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  floatingButton: {
    position: "absolute",
    right: theme.spacing[3],
    zIndex: 20,
  },
}));
