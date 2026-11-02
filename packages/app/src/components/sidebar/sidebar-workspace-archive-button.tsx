import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Text, type GestureResponderEvent, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Check } from "lucide-react-native";
import { isWeb } from "@/constants/platform";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { densityIconProps } from "@/styles/density";
import type { Theme } from "@/styles/theme";

const ThemedCheck = withUnistyles(Check);
const iconProps = densityIconProps("sm", (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
}));
const iconActiveProps = densityIconProps("sm", (theme: Theme) => ({
  color: theme.colors.foreground,
}));

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
      <TooltipTrigger
        hitSlop={4}
        style={buttonStyle}
        disabled={pending}
        onPress={handlePress}
        accessibilityRole={isWeb ? undefined : "button"}
        accessibilityLabel={label}
        testID={`sidebar-workspace-archive-${workspaceKey}`}
      >
        {renderIcon}
      </TooltipTrigger>
      <TooltipContent side="bottom" align="center" offset={8}>
        <Text style={styles.tooltipText}>{label}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

function renderIcon({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) {
  return <ThemedCheck uniProps={hovered || pressed ? iconActiveProps : iconProps} />;
}

function buttonStyle({
  hovered = false,
  pressed,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.button, (hovered || pressed) && styles.buttonActive];
}

const styles = StyleSheet.create((theme) => ({
  // The kebab trigger's box, so the two icons share one rail, one hover chip, and one compact
  // tap size. The negative trailing margin on compact pulls the kebab's padded hit box back
  // under this one, so the two glyphs sit as close as they do on desktop.
  button: {
    width: { xs: 32, md: 18 },
    height: { xs: 32, md: 18 },
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 4,
    marginTop: { xs: -6, md: 0 },
    marginRight: { xs: -12, md: 0 },
  },
  buttonActive: {
    backgroundColor: theme.colors.surface2,
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
}));
