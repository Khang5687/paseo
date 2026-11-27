import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet as RNStyleSheet, Text, View } from "react-native";
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { StyleSheet } from "react-native-unistyles";
import type { ProjectStatusCounts } from "@/hooks/sidebar-workspaces-view-model";
import { listProjectStatusDots, type ProjectStatusDot } from "./project-strip-model";

const BLINK_HALF_MS = 700;
const DOT_SIZE = 6;

/**
 * One dot per chat beside a project icon on the strip: purple asks you, red failed, green is done
 * and not opened yet, blue blinks while working. Past four, the last place is a "+".
 */
export function ProjectStatusDots({
  counts,
  direction,
}: {
  counts: ProjectStatusCounts;
  /** The rail stacks them down the icon's right edge; a chip lines them up after its name. */
  direction: "column" | "row";
}) {
  const { dots, more } = listProjectStatusDots(counts);
  if (dots.length === 0) return null;
  return (
    <View
      style={direction === "column" ? styles.column : styles.row}
      pointerEvents="none"
      testID="sidebar-project-status-dots"
    >
      {keyDots(dots).map(({ dot, key }) => (
        <StatusDot key={key} dot={dot} />
      ))}
      {more ? <Text style={styles.more}>+</Text> : null}
    </View>
  );
}

/** Dots of one status are alike; their place within that status keeps each one's key steady. */
function keyDots(dots: readonly ProjectStatusDot[]): Array<{ dot: ProjectStatusDot; key: string }> {
  const seen: Partial<Record<ProjectStatusDot, number>> = {};
  return dots.map((dot) => {
    const nth = seen[dot] ?? 0;
    seen[dot] = nth + 1;
    return { dot, key: `${dot}-${nth}` };
  });
}

function StatusDot({ dot }: { dot: ProjectStatusDot }) {
  if (dot === "running") return <BlinkingDot />;
  return <PlainDot dot={dot} testID={`sidebar-project-status-dot-${dot}`} />;
}

function PlainDot({ dot, testID }: { dot: ProjectStatusDot; testID?: string }) {
  switch (dot) {
    case "needs_input":
      return <View style={[styles.dot, styles.needsInput]} testID={testID} />;
    case "failed":
      return <View style={[styles.dot, styles.failed]} testID={testID} />;
    case "attention":
      return <View style={[styles.dot, styles.attention]} testID={testID} />;
    case "running":
      return <View style={[styles.dot, styles.running]} testID={testID} />;
  }
}

// Unistyles styles never go on the Animated.View (docs/unistyles.md): it only fades, and the
// themed dot sits inside it.
function BlinkingDot() {
  const reduceMotion = useReducedMotion();
  const opacity = useSharedValue(1);
  useEffect(() => {
    if (reduceMotion) {
      opacity.value = 1;
      return;
    }
    opacity.value = withRepeat(withTiming(0.35, { duration: BLINK_HALF_MS }), -1, true);
    return () => cancelAnimation(opacity);
  }, [opacity, reduceMotion]);
  const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View
      style={[blinkStyles.box, animatedStyle]}
      testID="sidebar-project-status-dot-running"
    >
      <PlainDot dot="running" />
    </Animated.View>
  );
}

const PROJECT_STATUS_ORDER: ReadonlyArray<[ProjectStatusDot, keyof ProjectStatusCounts]> = [
  ["needs_input", "needsInput"],
  ["failed", "failed"],
  ["attention", "attention"],
  ["running", "running"],
];

/** The exact counts, for the open rail, in the dots' order: a dot and a number per status. */
export function ProjectStatusCountList({ counts }: { counts: ProjectStatusCounts }) {
  const entries = PROJECT_STATUS_ORDER.filter(([, key]) => counts[key] > 0);
  if (entries.length === 0) return null;
  return (
    <View style={styles.counts} testID="sidebar-project-status-counts">
      {entries.map(([dot, key]) => (
        <View key={dot} style={styles.countEntry}>
          <PlainDot dot={dot} />
          <Text style={styles.countText}>{counts[key]}</Text>
        </View>
      ))}
    </View>
  );
}

const STATUS_LABEL_KEYS: Record<ProjectStatusDot, string> = {
  needs_input: "sidebar.projectStrip.statusAsking",
  failed: "sidebar.projectStrip.statusFailed",
  attention: "sidebar.projectStrip.statusDone",
  running: "sidebar.projectStrip.statusWorking",
};

/** "Asking you: 1, Working: 2": the counts in words, for tooltips and screen readers. */
export function useProjectStatusLabel(counts: ProjectStatusCounts): string | null {
  const { t } = useTranslation();
  const parts = PROJECT_STATUS_ORDER.filter(([, key]) => counts[key] > 0).map(([dot, key]) =>
    t(STATUS_LABEL_KEYS[dot], { count: counts[key] }),
  );
  return parts.length > 0 ? parts.join(", ") : null;
}

const blinkStyles = RNStyleSheet.create({
  box: { width: DOT_SIZE, height: DOT_SIZE },
});

const styles = StyleSheet.create((theme) => ({
  column: {
    position: "absolute",
    top: 1,
    right: -4,
    alignItems: "center",
    gap: 2,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
  },
  dot: {
    width: DOT_SIZE,
    height: DOT_SIZE,
    borderRadius: DOT_SIZE / 2,
  },
  // The palette purple, as on the New main agent dot: a project asking you reads apart from the
  // orange status dot of a single workspace row.
  needsInput: {
    backgroundColor: theme.colors.palette.purple[500],
  },
  failed: {
    backgroundColor: theme.colors.statusDotDanger,
  },
  attention: {
    backgroundColor: theme.colors.statusDotSuccess,
  },
  running: {
    backgroundColor: theme.colors.statusDotRunning,
  },
  more: {
    fontSize: 9,
    lineHeight: 9,
    fontWeight: theme.fontWeight.bold,
    color: theme.colors.foregroundMuted,
  },
  counts: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  countEntry: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
  },
  countText: {
    fontSize: 11,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
    fontVariant: ["tabular-nums"],
  },
}));
