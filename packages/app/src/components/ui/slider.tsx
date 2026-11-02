import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  StyleSheet as RNStyleSheet,
  View,
  type AccessibilityActionEvent,
  type LayoutChangeEvent,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { StyleSheet } from "react-native-unistyles";
import { scheduleOnRN } from "react-native-worklets";
import { isWeb } from "@/constants/platform";
import {
  sliderFraction,
  sliderValueAtPosition,
  sliderValueForKey,
  snapSliderValue,
  type SliderRange,
} from "./slider-math";

const HIT_HEIGHT = 44;
const THUMB_SIZE = 20;
const TRACK_HEIGHT = 4;
/** The thumb's center stops this far from each end, so the thumb never overhangs the track. */
const THUMB_INSET = THUMB_SIZE / 2;
/** Live values reach `onValueChange` at most this often while dragging. */
const LIVE_INTERVAL_MS = 100;
const PAN_ACTIVE_OFFSET_X = 4;
const PAN_FAIL_OFFSET_Y = 12;
const ACCESSIBILITY_ACTIONS = [{ name: "increment" }, { name: "decrement" }];

interface WebKeyboardEvent {
  key: string;
  preventDefault: () => void;
}

interface WebFocusEvent {
  target: unknown;
}

export interface SliderProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Live value while dragging or holding a key, at most every 100 ms. */
  onValueChange?: (value: number) => void;
  /** Final value, once per drag, tap, key release, or accessibility action. */
  onSlidingComplete: (value: number) => void;
  /** Spoken and exposed as the accessible value, e.g. "40%". */
  formatValue: (value: number) => string;
  accessibilityLabel: string;
  disabled?: boolean;
  testID?: string;
}

/**
 * Horizontal slider. The thumb follows the finger on the UI thread; JS only hears about step
 * changes, forwards them to `onValueChange` at most every 100 ms, and calls
 * `onSlidingComplete` once at the end, so a caller can preview live and persist once.
 */
export function Slider({
  value: valueProp,
  min,
  max,
  step = 1,
  onValueChange,
  onSlidingComplete,
  formatValue,
  accessibilityLabel,
  disabled = false,
  testID,
}: SliderProps) {
  const range = useMemo<SliderRange>(() => ({ min, max, step }), [min, max, step]);
  const value = snapSliderValue(valueProp, range);

  const width = useSharedValue(0);
  const fraction = useSharedValue(sliderFraction(value, range));
  /** Last step the UI thread reported, so JS only hears about changes. */
  const reported = useSharedValue(value);
  const panActive = useSharedValue(false);

  const liveRef = useRef(value);
  /** True from the first move or key press until the value is committed. */
  const adjustingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastEmitRef = useRef(0);
  const onValueChangeRef = useRef(onValueChange);
  const onSlidingCompleteRef = useRef(onSlidingComplete);
  const [focusVisible, setFocusVisible] = useState(false);

  useEffect(() => {
    onValueChangeRef.current = onValueChange;
    onSlidingCompleteRef.current = onSlidingComplete;
  }, [onValueChange, onSlidingComplete]);

  // Follow the prop except mid-adjustment, where it trails the thumb by up to one live interval.
  useEffect(() => {
    if (adjustingRef.current) return;
    liveRef.current = value;
    reported.value = value;
    fraction.value = sliderFraction(value, range);
  }, [fraction, range, reported, value]);

  const cancelLive = useCallback(() => {
    if (timerRef.current === null) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  useEffect(() => cancelLive, [cancelLive]);

  const flushLive = useCallback(() => {
    timerRef.current = null;
    lastEmitRef.current = Date.now();
    onValueChangeRef.current?.(liveRef.current);
  }, []);

  const emitLive = useCallback(
    (next: number) => {
      adjustingRef.current = true;
      liveRef.current = next;
      // A pending flush reads liveRef, so it already carries this value.
      if (timerRef.current !== null) return;
      const wait = lastEmitRef.current + LIVE_INTERVAL_MS - Date.now();
      if (wait <= 0) flushLive();
      else timerRef.current = setTimeout(flushLive, wait);
    },
    [flushLive],
  );

  const commit = useCallback(
    (next: number) => {
      cancelLive();
      adjustingRef.current = false;
      liveRef.current = next;
      onSlidingCompleteRef.current(next);
    },
    [cancelLive],
  );

  const gesture = useMemo(() => {
    const moveTo = (x: number) => {
      "worklet";
      const next = sliderValueAtPosition(x, width.value, THUMB_INSET, range);
      fraction.value = sliderFraction(next, range);
      if (next !== reported.value) {
        reported.value = next;
        scheduleOnRN(emitLive, next);
      }
    };
    const pan = Gesture.Pan()
      .enabled(!disabled)
      .activeOffsetX([-PAN_ACTIVE_OFFSET_X, PAN_ACTIVE_OFFSET_X])
      .failOffsetY([-PAN_FAIL_OFFSET_Y, PAN_FAIL_OFFSET_Y])
      .onStart((event) => {
        panActive.value = true;
        moveTo(event.x);
      })
      .onUpdate((event) => {
        moveTo(event.x);
      })
      .onFinalize(() => {
        if (!panActive.value) return;
        panActive.value = false;
        scheduleOnRN(commit, reported.value);
      });
    const tap = Gesture.Tap()
      .enabled(!disabled)
      .onEnd((event, success) => {
        if (!success) return;
        const next = sliderValueAtPosition(event.x, width.value, THUMB_INSET, range);
        fraction.value = sliderFraction(next, range);
        reported.value = next;
        scheduleOnRN(commit, next);
      });
    return Gesture.Race(pan, tap);
  }, [commit, disabled, emitLive, fraction, panActive, range, reported, width]);

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      width.value = event.nativeEvent.layout.width;
    },
    [width],
  );

  const setValueFromJs = useCallback(
    (next: number) => {
      fraction.value = sliderFraction(next, range);
      reported.value = next;
    },
    [fraction, range, reported],
  );

  const handleAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      const { actionName } = event.nativeEvent;
      if (disabled || (actionName !== "increment" && actionName !== "decrement")) return;
      const key = actionName === "increment" ? "ArrowRight" : "ArrowLeft";
      const next = sliderValueForKey(key, liveRef.current, range);
      if (next === null || next === liveRef.current) return;
      setValueFromJs(next);
      commit(next);
    },
    [commit, disabled, range, setValueFromJs],
  );

  const webHandlers = useMemo(() => {
    if (!isWeb) return null;
    return {
      onKeyDown: (event: WebKeyboardEvent) => {
        if (disabled) return;
        const next = sliderValueForKey(event.key, liveRef.current, range);
        if (next === null) return;
        event.preventDefault();
        if (next === liveRef.current && !adjustingRef.current) return;
        setValueFromJs(next);
        emitLive(next);
      },
      onKeyUp: (event: WebKeyboardEvent) => {
        if (!adjustingRef.current || sliderValueForKey(event.key, 0, range) === null) return;
        commit(liveRef.current);
      },
      onFocus: (event: WebFocusEvent) => {
        const target = event.target as { matches?: (selector: string) => boolean } | null;
        setFocusVisible(target?.matches?.(":focus-visible") === true);
      },
      onBlur: () => {
        setFocusVisible(false);
        if (adjustingRef.current) commit(liveRef.current);
      },
    };
  }, [commit, disabled, emitLive, range, setValueFromJs]);

  const fillStyle = useAnimatedStyle(() => {
    const travel = Math.max(0, width.value - THUMB_SIZE);
    // A full-width fill slid left, so dragging moves a transform instead of relaying out.
    return {
      transform: [{ translateX: THUMB_INSET + fraction.value * travel - width.value }],
    };
  });
  const thumbStyle = useAnimatedStyle(() => {
    const travel = Math.max(0, width.value - THUMB_SIZE);
    return { transform: [{ translateX: fraction.value * travel }] };
  });

  const accessibilityState = useMemo(() => ({ disabled }), [disabled]);

  return (
    // pan-y leaves vertical swipes to the browser so the page still scrolls on touch web.
    <GestureDetector gesture={gesture} touchAction="pan-y">
      <View
        style={[styles.hitArea, disabled && styles.disabled]}
        onLayout={handleLayout}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={accessibilityState}
        accessibilityActions={ACCESSIBILITY_ACTIONS}
        onAccessibilityAction={handleAccessibilityAction}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={formatValue(value)}
        tabIndex={disabled ? undefined : 0}
        testID={testID}
        {...webHandlers}
      >
        <View style={styles.track}>
          <Animated.View style={[layout.fill, fillStyle]}>
            <View style={styles.fill} />
          </Animated.View>
        </View>
        <Animated.View style={[layout.thumbSlot, thumbStyle]}>
          <View style={[styles.thumb, focusVisible && styles.thumbFocused]} />
        </Animated.View>
      </View>
    </GestureDetector>
  );
}

// Reanimated views take static styles only; themed colors sit on plain children.
const layout = RNStyleSheet.create({
  fill: {
    ...RNStyleSheet.absoluteFill,
  },
  thumbSlot: {
    position: "absolute",
    left: 0,
    top: (HIT_HEIGHT - THUMB_SIZE) / 2,
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    pointerEvents: "none",
  },
});

const styles = StyleSheet.create((theme) => ({
  hitArea: {
    height: HIT_HEIGHT,
    justifyContent: "center",
    outlineWidth: 0,
  },
  track: {
    height: TRACK_HEIGHT,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
    overflow: "hidden",
    pointerEvents: "none",
  },
  fill: {
    flex: 1,
    backgroundColor: theme.colors.accent,
  },
  thumb: {
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: THUMB_SIZE / 2,
    backgroundColor: theme.colors.palette.white,
    shadowColor: "rgba(0, 0, 0, 0.25)",
    shadowOffset: { width: 0, height: 1 },
    shadowRadius: 2,
    shadowOpacity: 1,
    elevation: 2,
  },
  thumbFocused: {
    outlineColor: theme.colors.accent,
    outlineStyle: "solid",
    outlineWidth: 2,
    outlineOffset: 2,
  },
  disabled: {
    opacity: theme.opacity[50],
  },
}));
