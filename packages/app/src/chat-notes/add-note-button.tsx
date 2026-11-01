import { memo } from "react";
import { StyleSheet } from "react-native-unistyles";
import { StickyNote, StickyNotePlus } from "lucide-react-native";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { ICON_SIZE } from "@/styles/theme";

interface AddNoteButtonProps {
  onPress: () => void;
  accessibilityLabel: string;
  /** The message already carries a note: the icon shows it, since native draws no highlight. */
  marked?: boolean;
}

/** Message-level "Add note", the touch path where a selection menu cannot offer it. */
export const AddNoteButton = memo(function AddNoteButton({
  onPress,
  accessibilityLabel,
  marked = false,
}: AddNoteButtonProps) {
  return (
    <ToolbarButton label={accessibilityLabel} onPress={onPress} compact>
      {marked ? (
        <StickyNote size={ICON_SIZE.sm} color={styles.iconMarked.color} />
      ) : (
        <StickyNotePlus size={ICON_SIZE.sm} color={styles.icon.color} />
      )}
    </ToolbarButton>
  );
});

const styles = StyleSheet.create((theme) => ({
  icon: {
    color: theme.colors.foregroundMuted,
  },
  iconMarked: {
    color: theme.colors.statusWarning,
  },
}));
