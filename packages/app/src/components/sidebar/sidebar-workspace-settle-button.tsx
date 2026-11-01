import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  Pressable,
  Text,
  View,
  type GestureResponderEvent,
  type PressableStateCallbackType,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Check, Undo2 } from "lucide-react-native";
import { isWeb } from "@/constants/platform";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Theme } from "@/styles/theme";

const ThemedCheck = withUnistyles(Check);
const ThemedUndo2 = withUnistyles(Undo2);
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/**
 * The row's hover Settle / Unsettle action, sitting in the trailing overlay beside the kebab.
 * Desktop hover only: touch rows keep the kebab alone, whose menu carries the same action.
 * Hidden with opacity and pointer events rather than unmounted, so the overlay keeps its width
 * while the kebab's menu holds it open after the pointer has left the row.
 */
export function SidebarWorkspaceSettleButton({
  workspaceKey,
  isSettled,
  visible,
  onToggleSettle,
}: {
  workspaceKey: string;
  isSettled: boolean;
  visible: boolean;
  onToggleSettle: () => void;
}) {
  const { t } = useTranslation();
  const label = isSettled
    ? t("sidebar.workspace.actions.unsettleWorkspace")
    : t("sidebar.workspace.actions.settleWorkspace");
  const Icon = isSettled ? ThemedUndo2 : ThemedCheck;

  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      onToggleSettle();
    },
    [onToggleSettle],
  );

  return (
    <View style={visible ? undefined : styles.slotHidden} pointerEvents={visible ? "auto" : "none"}>
      <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild disabled={!visible}>
          <Pressable
            hitSlop={4}
            style={buttonStyle}
            onPress={handlePress}
            accessibilityRole={isWeb ? undefined : "button"}
            accessibilityLabel={label}
            testID={`sidebar-workspace-settle-${workspaceKey}`}
          >
            {({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => (
              <Icon
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
    </View>
  );
}

function buttonStyle({ hovered = false }: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.button, hovered && styles.buttonHovered];
}

const styles = StyleSheet.create((theme) => ({
  slotHidden: {
    opacity: 0,
  },
  // Same box as the kebab trigger beside it, so the two icons share one rail and hover chip.
  button: {
    padding: 2,
    borderRadius: 4,
  },
  buttonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
}));
