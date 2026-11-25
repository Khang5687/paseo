import { useCallback, useMemo } from "react";
import { Text } from "react-native";
import { router, usePathname } from "expo-router";
import { HardDriveDownload } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { builtinSidebarNavLabelKey } from "@/sidebar-nav/model";
import { buildSavedRoute } from "@/utils/host-routes";

/** The footer row that opens this device's Saved library, with how many files it holds. */
export function SavedSidebarItem({
  count,
  onBeforeNavigate,
}: {
  count: number;
  onBeforeNavigate?: () => void;
}) {
  const { t } = useTranslation();
  const pathname = usePathname();
  const open = useCallback(() => {
    onBeforeNavigate?.();
    router.push(buildSavedRoute());
  }, [onBeforeNavigate]);
  const trailing = useMemo(
    () => (
      <Text style={styles.count} testID="sidebar-saved-count">
        {count}
      </Text>
    ),
    [count],
  );
  return (
    <SidebarHeaderRow
      icon={HardDriveDownload}
      label={t(builtinSidebarNavLabelKey("saved"))}
      onPress={open}
      isActive={pathname.startsWith(buildSavedRoute())}
      variant="inline"
      trailing={trailing}
      testID="sidebar-saved"
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  count: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
