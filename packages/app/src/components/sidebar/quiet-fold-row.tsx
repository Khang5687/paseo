import { ChevronDown, ChevronRight, Ellipsis } from "lucide-react-native";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useSidebarModel } from "@/components/sidebar/sidebar-model";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useSidebarQuietFoldStore } from "@/stores/sidebar-quiet-fold-store";
import type { Theme } from "@/styles/theme";

const ThemedEllipsis = withUnistyles(Ellipsis);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/**
 * The project list's "More" row: it sits after the projects that show and opens or closes the
 * quiet ones (no chat activity for 3 days). Opened, they list above it, at the end of the list.
 */
export function SidebarQuietFoldRow() {
  const { t } = useTranslation();
  const { listQuietCount } = useSidebarModel();
  const open = useSidebarQuietFoldStore((state) => state.open);
  const toggle = useSidebarQuietFoldStore((state) => state.toggle);
  const [hovered, setHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setHovered(true), []);
  const handlePointerLeave = useCallback(() => setHovered(false), []);

  if (listQuietCount === 0) return null;

  return (
    <View onPointerEnter={handlePointerEnter} onPointerLeave={handlePointerLeave}>
      <PressHighlight
        accessibilityRole="button"
        aria-expanded={open}
        highlightStyle={styles.rowPressed}
        onPress={toggle}
        style={[styles.row, hovered ? styles.rowHovered : null]}
        testID="sidebar-quiet-fold-row"
      >
        <View style={styles.icon}>
          <ThemedEllipsis size={14} uniProps={mutedIconMapping} />
        </View>
        <Text style={styles.label} numberOfLines={1}>
          {t("sidebar.projectStrip.quietMore", { count: listQuietCount })}
        </Text>
        {open ? (
          <ThemedChevronDown size={14} uniProps={mutedIconMapping} />
        ) : (
          <ThemedChevronRight size={14} uniProps={mutedIconMapping} />
        )}
      </PressHighlight>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    minHeight: 32,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginHorizontal: theme.spacing[2],
    marginTop: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  rowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  icon: {
    width: 20,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
  },
  label: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
}));
