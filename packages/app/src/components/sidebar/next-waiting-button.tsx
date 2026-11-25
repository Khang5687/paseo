import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { countOtherWaiting, nextWaitingWorkspace } from "@/components/sidebar/jump-targets";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useWaitingWorkspaces } from "@/hooks/use-waiting-workspaces";
import {
  navigateToWorkspace,
  useLastWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import { getStatusDotColor } from "@/utils/status-dot-color";

/**
 * The phone's answer to Cmd+J: opens the next workspace waiting on you, in any project, and
 * closes the sidebar. It shows only while some other workspace is waiting.
 */
export function NextWaitingButton({ onNavigate }: { onNavigate: () => void }) {
  const { t } = useTranslation();
  const waiting = useWaitingWorkspaces();
  const openWorkspace = useLastWorkspaceSelection();
  const count = useMemo(() => countOtherWaiting(waiting, openWorkspace), [openWorkspace, waiting]);
  const handlePress = useCallback(() => {
    const target = nextWaitingWorkspace(waiting, openWorkspace);
    if (!target) return;
    navigateToWorkspace(target);
    onNavigate();
  }, [onNavigate, openWorkspace, waiting]);

  if (count === 0) return null;
  const label = t("sidebar.projectStrip.nextWaiting", { count });
  return (
    <View style={styles.container}>
      <PressHighlight
        accessibilityRole="button"
        accessibilityLabel={label}
        highlightStyle={styles.buttonPressed}
        onPress={handlePress}
        style={styles.button}
        testID="sidebar-next-waiting"
      >
        <View style={styles.dot} />
        <Text style={styles.label}>{label}</Text>
      </PressHighlight>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    alignItems: "center",
  },
  button: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  buttonPressed: {
    backgroundColor: theme.colors.surface2,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
    backgroundColor: getStatusDotColor({ theme, bucket: "needs_input" }) ?? theme.colors.accent,
  },
  label: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
  },
}));
