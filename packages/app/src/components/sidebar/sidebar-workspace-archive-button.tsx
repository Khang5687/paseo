import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  Pressable,
  Text,
  type GestureResponderEvent,
  type PressableStateCallbackType,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Check } from "lucide-react-native";
import { isWeb } from "@/constants/platform";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Theme } from "@/styles/theme";

const ThemedCheck = withUnistyles(Check);
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/**
 * One-press Archive beside the row's kebab. It runs the same action as the menu's Archive item,
 * including the worktree confirmation when the row's git state shows uncommitted or unpushed
 * work. It appears wherever the kebab does: on hover on desktop, and permanently on touch,
 * where there is no hover.
 */
export function SidebarWorkspaceArchiveButton({
  workspaceKey,
  pending,
  onArchive,
}: {
  workspaceKey: string;
  pending: boolean;
  onArchive: () => void;
}) {
  const { t } = useTranslation();
  const label = t("sidebar.workspace.actions.archiveWorkspace");

  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      // The row underneath navigates on press.
      event.stopPropagation();
      onArchive();
    },
    [onArchive],
  );

  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild>
        <Pressable
          hitSlop={4}
          style={buttonStyle}
          disabled={pending}
          onPress={handlePress}
          accessibilityRole={isWeb ? undefined : "button"}
          accessibilityLabel={label}
          testID={`sidebar-workspace-archive-${workspaceKey}`}
        >
          {({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => (
            <ThemedCheck
              size={14}
              uniProps={hovered || pressed ? foregroundColorMapping : foregroundMutedColorMapping}
            />
          )}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="center" offset={8}>
        <Text style={styles.tooltipText}>{label}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

function buttonStyle({
  hovered = false,
  pressed,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.button, (hovered || pressed) && styles.buttonActive];
}

const styles = StyleSheet.create((theme) => ({
  // Same box as the kebab trigger beside it, so the two icons share one rail and hover chip.
  button: {
    padding: 2,
    borderRadius: 4,
  },
  buttonActive: {
    backgroundColor: theme.colors.surface2,
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
}));
