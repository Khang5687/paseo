import { useEffect, useState } from "react";
import { AccessibilityInfo, Platform } from "react-native";

/**
 * Subscribes to a boolean OS accessibility setting. `read` is skipped (value stays false)
 * on platforms that do not expose it.
 */
type AccessibilityChangeEvent =
  | "reduceTransparencyChanged"
  | "reduceMotionChanged"
  | "darkerSystemColorsChanged"
  | "highTextContrastChanged";

interface AccessibilitySignal {
  read: () => Promise<boolean>;
  changeEvent: AccessibilityChangeEvent;
}

function useAccessibilitySetting(signal: AccessibilitySignal | null): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    if (!signal) return undefined;
    let cancelled = false;
    signal.read().then(
      (value) => {
        if (!cancelled) setEnabled(value);
        return undefined;
      },
      () => undefined,
    );
    const subscription = AccessibilityInfo.addEventListener(signal.changeEvent, setEnabled);
    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, [signal]);
  return enabled;
}

function platformSignal(
  ios: AccessibilitySignal | null,
  android: AccessibilitySignal | null,
): AccessibilitySignal | null {
  if (Platform.OS === "ios") return ios;
  if (Platform.OS === "android") return android;
  return null;
}

// React Native exposes reduce transparency on iOS only.
const REDUCE_TRANSPARENCY = platformSignal(
  {
    read: () => AccessibilityInfo.isReduceTransparencyEnabled(),
    changeEvent: "reduceTransparencyChanged",
  },
  null,
);

const MORE_CONTRAST = platformSignal(
  {
    read: () => AccessibilityInfo.isDarkerSystemColorsEnabled(),
    changeEvent: "darkerSystemColorsChanged",
  },
  {
    read: () => AccessibilityInfo.isHighTextContrastEnabled(),
    changeEvent: "highTextContrastChanged",
  },
);

const REDUCE_MOTION: AccessibilitySignal = {
  read: () => AccessibilityInfo.isReduceMotionEnabled(),
  changeEvent: "reduceMotionChanged",
};

export function useReduceTransparency(): boolean {
  return useAccessibilitySetting(REDUCE_TRANSPARENCY);
}

export function usePrefersMoreContrast(): boolean {
  return useAccessibilitySetting(MORE_CONTRAST);
}

/** Forced colors is a browser feature; native platforms have no equivalent. */
export function useForcedColors(): boolean {
  return false;
}

export function useReduceMotion(): boolean {
  return useAccessibilitySetting(REDUCE_MOTION);
}
