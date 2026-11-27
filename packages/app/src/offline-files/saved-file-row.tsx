import { useMemo } from "react";
import { Text, View, type GestureResponderEvent } from "react-native";
import { Check, Pin } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { MaterialFileIcon } from "@/components/material-file-icon";
import { PressHighlight } from "@/components/ui/press-highlight";
import type { Theme } from "@/styles/theme";
import { formatFileSize } from "@/utils/format-file-size";
import { formatTimeAgo } from "@/utils/time";
import type { SavedFileItem } from "./saved-list";

const FILE_ICON_SIZE = 20;
const PIN_ICON_SIZE = 12;
const CHECK_ICON_SIZE = 13;
const ThemedPin = withUnistyles(Pin);
const ThemedCheck = withUnistyles(Check);
const accentColor = (theme: Theme) => ({ color: theme.colors.accent });
const onAccentColor = (theme: Theme) => ({ color: theme.colors.accentForeground });

export interface SavedFileRowProps {
  item: SavedFileItem;
  onPress: (event: GestureResponderEvent) => void;
  onLongPress?: () => void;
  /** In select mode: whether this row is picked. Undefined outside select mode. */
  selected?: boolean;
  /** False under a heading that already names the device, as in Settings → Files. */
  showDevice?: boolean;
  accessibilityHint?: string;
  accessibilityActions?: { name: string; label: string }[];
  onAccessibilityAction?: () => void;
}

/**
 * One saved file: its whole name on up to two lines, then project · device · when, the size on
 * the right, and a pin on files saved on purpose. The absolute path is on the file's own page.
 */
export function SavedFileRow({
  item,
  onPress,
  onLongPress,
  selected,
  showDevice = true,
  accessibilityHint,
  accessibilityActions,
  onAccessibilityAction,
}: SavedFileRowProps) {
  const { file, name } = item;
  const selecting = selected !== undefined;
  const state = useMemo(
    () => (selecting ? { checked: selected } : undefined),
    [selecting, selected],
  );
  return (
    <PressHighlight
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole={selecting ? "checkbox" : "button"}
      accessibilityState={state}
      accessibilityLabel={name}
      accessibilityHint={accessibilityHint}
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={onAccessibilityAction}
      style={[styles.row, selected ? styles.rowSelected : null]}
      testID="offline-files-row"
    >
      {selecting ? (
        <View style={[styles.check, selected ? styles.checkOn : null]}>
          {selected ? <ThemedCheck size={CHECK_ICON_SIZE} uniProps={onAccentColor} /> : null}
        </View>
      ) : null}
      <MaterialFileIcon fileName={name} size={FILE_ICON_SIZE} />
      <View style={styles.text}>
        <Text style={styles.name} numberOfLines={2}>
          {name}
        </Text>
        <View style={styles.metaRow}>
          {file.pinned ? (
            <View testID="offline-files-row-pinned">
              <ThemedPin size={PIN_ICON_SIZE} uniProps={accentColor} />
            </View>
          ) : null}
          <Text style={styles.meta} numberOfLines={1}>
            {showDevice
              ? `${item.project} · ${item.device} · ${formatTimeAgo(new Date(file.savedAt))}`
              : `${item.project} · ${formatTimeAgo(new Date(file.savedAt))}`}
          </Text>
        </View>
      </View>
      <Text style={styles.size}>{formatFileSize(file.size)}</Text>
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  rowSelected: {
    backgroundColor: theme.colors.surface2,
  },
  check: {
    width: 20,
    height: 20,
    marginTop: 1,
    borderRadius: theme.borderRadius.full,
    borderWidth: 1.5,
    borderColor: theme.colors.foregroundMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  checkOn: {
    backgroundColor: theme.colors.accent,
    borderColor: theme.colors.accent,
  },
  text: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[0.5],
  },
  name: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  meta: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  size: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
