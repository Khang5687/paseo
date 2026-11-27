import type { PluginBadge } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

/** Counts past this show as "99+". */
const MAX_COUNT = 99;

/** The row's own label with the badge's count after it, for screen readers. */
export function sidebarBadgeAccessibilityLabel(
  label: string,
  badge: PluginBadge | null | undefined,
): string {
  if (!badge || badge.count === undefined || badge.count <= 0) return label;
  return `${label}, ${badge.count}`;
}

/**
 * A plugin's count or dot, or nothing when `badge` is null. `inline` sits at the end of a
 * full-width row; `corner` sits on the top right corner of an icon button, ringed in the sidebar
 * color so it reads against the button. Its test ID is the owner's with `-badge` added.
 */
export function SidebarBadge({
  badge,
  placement,
  ownerTestID,
}: {
  badge: PluginBadge | null | undefined;
  placement: "inline" | "corner";
  ownerTestID?: string;
}) {
  if (!badge) return null;
  const count = badge.count !== undefined && badge.count > 0 ? badge.count : null;
  const corner = placement === "corner";
  let shapeStyle = count === null ? styles.dot : styles.pill;
  if (corner) shapeStyle = count === null ? styles.cornerDot : styles.cornerPill;
  return (
    <View
      pointerEvents="none"
      style={[
        shapeStyle,
        badge.tone === "attention" ? styles.attention : styles.warning,
        corner ? styles.corner : styles.inline,
      ]}
      testID={ownerTestID ? `${ownerTestID}-badge` : undefined}
    >
      {count === null ? null : (
        <Text style={styles.count}>{count > MAX_COUNT ? `${MAX_COUNT}+` : String(count)}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  pill: {
    minWidth: 18,
    height: 18,
    paddingHorizontal: 5,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.full,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
  },
  // The 2px ring is drawn inside the box, so the corner shapes are 4px wider for the same fill.
  cornerPill: {
    minWidth: 22,
    height: 22,
    paddingHorizontal: 5,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.full,
  },
  cornerDot: {
    width: 12,
    height: 12,
    borderRadius: theme.borderRadius.full,
  },
  attention: {
    backgroundColor: theme.colors.statusDotDanger,
  },
  warning: {
    backgroundColor: theme.colors.statusDotWarning,
  },
  inline: {
    marginLeft: "auto",
  },
  corner: {
    position: "absolute",
    top: -5,
    right: -5,
    borderWidth: 2,
    borderColor: theme.colors.surfaceSidebar,
  },
  count: {
    color: theme.colors.palette.white,
    fontSize: 10,
    fontWeight: theme.fontWeight.semibold,
    lineHeight: 12,
  },
}));
