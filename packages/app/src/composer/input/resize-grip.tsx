import { useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { StyleSheet } from "react-native-unistyles";
import { SIDEBAR_RESIZE_ACTIVATION_OFFSET } from "@/components/sidebar-resize-handle-layout";
import { isWeb } from "@/constants/platform";

interface ComposerResizeGripProps {
  accessibilityLabel: string;
  onDragStart: () => void;
  /** Pointer travel since the press; negative is up. */
  onDragMove: (deltaY: number) => void;
  onDragEnd: () => void;
  onReset: () => void;
}

/**
 * The grab bar on the composer's top border. Drag sets how tall the input may
 * grow; a double tap or double click goes back to the default.
 */
export function ComposerResizeGrip(props: ComposerResizeGripProps) {
  const [hovered, setHovered] = useState(false);
  const [dragging, setDragging] = useState(false);
  const callbacksRef = useRef(props);
  callbacksRef.current = props;
  // Held in a ref, not in the memo closure: on web, onBegin and onUpdate saw
  // different closure state, so every drag started from 0.
  const dragRef = useRef({ originY: 0, started: false, cursorBeforeDrag: "" });

  const gesture = useMemo(() => {
    const drag = Gesture.Pan()
      .runOnJS(true)
      .activeOffsetY([-SIDEBAR_RESIZE_ACTIVATION_OFFSET, SIDEBAR_RESIZE_ACTIVATION_OFFSET])
      // Gesture Handler resets web translation when the pan activates. Measure from
      // the press so the activation distance is part of the drag on every platform.
      .onBegin((event) => {
        dragRef.current.originY = event.absoluteY;
      })
      .onStart(() => {
        const state = dragRef.current;
        state.started = true;
        setDragging(true);
        // The pointer leaves the grip while dragging; keep the resize cursor with it.
        if (isWeb) {
          state.cursorBeforeDrag = document.body.style.cursor;
          document.body.style.cursor = "row-resize";
        }
        callbacksRef.current.onDragStart();
      })
      .onUpdate((event) =>
        callbacksRef.current.onDragMove(event.absoluteY - dragRef.current.originY),
      )
      .onFinalize(() => {
        const state = dragRef.current;
        if (!state.started) return;
        state.started = false;
        setDragging(false);
        if (isWeb) document.body.style.cursor = state.cursorBeforeDrag;
        callbacksRef.current.onDragEnd();
      });
    const reset = Gesture.Tap()
      .runOnJS(true)
      .numberOfTaps(2)
      .onEnd((_event, success) => {
        if (success) callbacksRef.current.onReset();
      });
    const hover = Gesture.Hover()
      .runOnJS(true)
      .onStart(() => setHovered(true))
      .onFinalize(() => setHovered(false));
    return Gesture.Simultaneous(hover, Gesture.Race(drag, reset));
  }, []);

  return (
    <GestureDetector gesture={gesture}>
      <View
        testID="composer-resize-grip"
        role="separator"
        aria-orientation="horizontal"
        accessibilityLabel={props.accessibilityLabel}
        collapsable={false}
        style={styles.hitArea}
      >
        <View
          pointerEvents="none"
          style={[styles.grip, (hovered || dragging) && styles.gripActive]}
        />
      </View>
    </GestureDetector>
  );
}

const HIT_WIDTH = 88;
const HIT_HEIGHT = 20;

const styles = StyleSheet.create((theme) => ({
  // Web hit-testing does not clip to the composer, so the target straddles the
  // border. Native hit-testing does clip, so there it hangs inside the box.
  hitArea: {
    position: "absolute",
    zIndex: 10,
    top: isWeb ? -HIT_HEIGHT / 2 : -theme.borderWidth[1],
    left: "50%",
    width: HIT_WIDTH,
    height: HIT_HEIGHT,
    marginLeft: -HIT_WIDTH / 2,
    alignItems: "center",
    justifyContent: isWeb ? "center" : "flex-start",
    ...(isWeb ? ({ cursor: "row-resize", touchAction: "none", userSelect: "none" } as object) : {}),
  },
  // Muted text colour, so the grip is easy to find without competing with the draft.
  grip: {
    width: 36,
    height: 4,
    marginTop: isWeb ? 0 : -1,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundMuted,
  },
  gripActive: {
    backgroundColor: theme.colors.foreground,
  },
}));
