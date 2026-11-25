import { useCallback, type ReactNode } from "react";
import { Text, type GestureResponderEvent, type PressableStateCallbackType } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { densityIconProps } from "@/styles/density";
import type { Theme } from "@/styles/theme";

export const sidebarIconButtonProps = densityIconProps("sm", (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
}));
export const sidebarIconButtonActiveProps = densityIconProps("sm", (theme: Theme) => ({
  color: theme.colors.foreground,
}));

/**
 * A one-press icon beside a row's kebab, with a tooltip on desktop. `renderIcon` is a module-level
 * function that draws a `withUnistyles` icon with `sidebarIconButtonProps` or, while hovered or
 * pressed, `sidebarIconButtonActiveProps`.
 */
export function SidebarWorkspaceIconButton({
  renderIcon,
  label,
  disabled,
  onPress,
  testID,
}: {
  renderIcon: (state: PressableStateCallbackType & { hovered?: boolean }) => ReactNode;
  label: string;
  disabled?: boolean;
  onPress: () => void;
  testID: string;
}) {
  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      // The row underneath navigates on press.
      event.stopPropagation();
      onPress();
    },
    [onPress],
  );

  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger
        hitSlop={4}
        style={buttonStyle}
        disabled={disabled}
        onPress={handlePress}
        accessibilityRole={isWeb ? undefined : "button"}
        accessibilityLabel={label}
        testID={testID}
      >
        {renderIcon}
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
  // The kebab trigger's box, so the icons share one rail, one hover chip, and one compact
  // tap size. The negative trailing margin on compact pulls the kebab's padded hit box back
  // under this one, so the glyphs sit as close as they do on desktop.
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
