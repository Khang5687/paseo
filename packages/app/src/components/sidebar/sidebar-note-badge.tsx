import { memo } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { CircleCheck, Clock } from "lucide-react-native";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ChatNoteBadge } from "@/notes/chat-badges";
import type { Theme } from "@/styles/theme";
import { STATUS_INDICATOR_ALERT_SIZE } from "@/utils/status-indicator-geometry";

const ThemedClock = withUnistyles(Clock);
const ThemedCircleCheck = withUnistyles(CircleCheck);
const waitingColorMapping = (theme: Theme) => ({ color: theme.colors.statusWarning });
const firedColorMapping = (theme: Theme) => ({ color: theme.colors.statusSuccess });

/** The row's note labels, for its own accessibility label and the badge's. */
export function chatNoteBadgeLabels(badge: ChatNoteBadge, t: TFunction): string[] {
  const labels: string[] = [];
  if (badge.waiting > 0) labels.push(t("notes.marker.waiting", { count: badge.waiting }));
  if (badge.fired > 0) labels.push(t("notes.marker.fired", { count: badge.fired }));
  return labels;
}

/**
 * A clock when a chat in the row has a note waiting on its event, a green check when one fired
 * since the owner last opened that chat. It sits beside the title rather than in the trailing
 * slot, which the kebab takes over on touch screens.
 */
export const SidebarNoteBadge = memo(function SidebarNoteBadge({
  badge,
  testID,
}: {
  badge: ChatNoteBadge;
  testID?: string;
}) {
  const { t } = useTranslation();
  if (badge.waiting === 0 && badge.fired === 0) return null;
  const label = chatNoteBadgeLabels(badge, t).join(", ");
  return (
    <Tooltip delayDuration={300} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild>
        <View
          style={styles.badge}
          role="img"
          accessibilityLabel={label}
          aria-label={label}
          testID={testID}
        >
          {badge.waiting > 0 ? (
            <ThemedClock size={STATUS_INDICATOR_ALERT_SIZE} uniProps={waitingColorMapping} />
          ) : null}
          {badge.fired > 0 ? (
            <ThemedCircleCheck size={STATUS_INDICATOR_ALERT_SIZE} uniProps={firedColorMapping} />
          ) : null}
        </View>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="center" offset={8}>
        <Text style={styles.tooltipText}>{label}</Text>
      </TooltipContent>
    </Tooltip>
  );
});

const styles = StyleSheet.create((theme) => ({
  // As tall as the row title's line, so the glyphs center on the title.
  badge: {
    height: 20,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 0,
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
}));
