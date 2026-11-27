import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type AccessibilityActionEvent,
  type GestureResponderEvent,
  StatusBar,
  View,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Modal } from "@/components/ui/modal";
import { useOverlayRegistration, type KeyboardInputEvent } from "@/keyboard";
import { useGlobalOverlayLayer } from "@/lib/overlay-root";
import { registerWakeTap, type WakeTap, type WakeTapPoint } from "@/voice/black-screen-wake";

interface VoiceBlackScreenProps {
  onWake: () => void;
}

const ACCESSIBILITY_ACTIONS = [{ name: "activate" }];
const claimTouch = () => true;
const keepTouch = () => false;

function tapPoint(event: GestureResponderEvent): WakeTapPoint {
  return { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY, at: Date.now() };
}

/**
 * Pure black over the whole window while live voice keeps running. It takes every touch through
 * the responder system (no press feedback), and only a double-tap (or Escape, or a screen
 * reader's activate) wakes it. No `onRequestClose`: Android back must not wake it from a pocket.
 */
export function VoiceBlackScreen({ onWake }: VoiceBlackScreenProps) {
  const { t } = useTranslation();
  const modalLayer = useGlobalOverlayLayer("modal", true);
  const pressStartRef = useRef<WakeTapPoint | null>(null);
  const pendingTapRef = useRef<WakeTap | null>(null);
  // On Android the modal is its own dialog window. React Native hides the status bar on the
  // app's window and on every dialog window it already knows, so hide it once the dialog is
  // shown; hidden earlier, the dialog keeps its bar. Imperative, not `<StatusBar hidden />`: the
  // component also resets the bar style when it unmounts, which overrides the theme's
  // `SystemBars` style and leaves white icons on a light app.
  const [shown, setShown] = useState(false);
  const handleShow = useCallback(() => setShown(true), []);
  useEffect(() => {
    if (!shown) return;
    StatusBar.setHidden(true);
    return () => StatusBar.setHidden(false);
  }, [shown]);

  const handleKeyDown = useCallback(
    (event: KeyboardInputEvent) => {
      if (event.key !== "Escape") return false;
      event.preventDefault();
      event.stopPropagation();
      onWake();
      return true;
    },
    [onWake],
  );
  const setOverlayScope = useOverlayRegistration({
    keys: ["Escape"],
    active: true,
    layer: modalLayer,
    onKeyDown: handleKeyDown,
  });

  const handleTouchStart = useCallback((event: GestureResponderEvent) => {
    pressStartRef.current = tapPoint(event);
  }, []);

  const handleTouchCancel = useCallback(() => {
    pressStartRef.current = null;
  }, []);

  const handleTouchEnd = useCallback(
    (event: GestureResponderEvent) => {
      const start = pressStartRef.current;
      pressStartRef.current = null;
      if (!start) return;
      const result = registerWakeTap(pendingTapRef.current, { start, end: tapPoint(event) });
      pendingTapRef.current = result.pending;
      if (result.wake) onWake();
    },
    [onWake],
  );

  const handleAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      if (event.nativeEvent.actionName === "activate") onWake();
    },
    [onWake],
  );

  return (
    <Modal visible transparent statusBarTranslucent navigationBarTranslucent onShow={handleShow}>
      <View
        ref={setOverlayScope}
        testID="voice-black-screen"
        accessible
        accessibilityRole="button"
        accessibilityLabel={t("realtimeVoice.blackScreen.wake")}
        accessibilityActions={ACCESSIBILITY_ACTIONS}
        onAccessibilityAction={handleAccessibilityAction}
        onStartShouldSetResponder={claimTouch}
        onResponderTerminationRequest={keepTouch}
        onResponderGrant={handleTouchStart}
        onResponderRelease={handleTouchEnd}
        onResponderTerminate={handleTouchCancel}
        style={styles.root}
      />
    </Modal>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    // Pure black whatever the theme or skin: OLED pixels are off.
    backgroundColor: theme.colors.palette.black,
  },
}));
