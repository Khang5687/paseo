import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import {
  setSkinBlur,
  setSkinShowBehindContent,
  setSkinShowBehindSidebar,
  setSkinVisibility,
  useSkinPreferences,
  type SkinBlur,
} from "@/skins";
import { settingsStyles } from "@/styles/settings";
import {
  nearestVisibilityPercent,
  VISIBILITY_PERCENT_OPTIONS,
  type VisibilityPercent,
} from "./selection";

const VISIBILITY_OPTIONS: SegmentedControlOption<`${VisibilityPercent}`>[] =
  VISIBILITY_PERCENT_OPTIONS.map((percent) => ({
    value: `${percent}` as const,
    label: `${percent}%`,
  }));

export function BackgroundControls() {
  const { t } = useTranslation();
  const preferences = useSkinPreferences();

  const blurOptions = useMemo<SegmentedControlOption<SkinBlur>[]>(
    () => [
      {
        value: "off",
        label: t("settings.appearance.background.blur.options.off"),
      },
      {
        value: "low",
        label: t("settings.appearance.background.blur.options.low"),
      },
      {
        value: "medium",
        label: t("settings.appearance.background.blur.options.medium"),
      },
      {
        value: "high",
        label: t("settings.appearance.background.blur.options.high"),
      },
    ],
    [t],
  );

  const handleVisibilityChange = useCallback((value: `${VisibilityPercent}`) => {
    setSkinVisibility(Number(value) / 100);
  }, []);

  return (
    <View style={settingsStyles.card}>
      <View style={styles.stackedRow}>
        <View style={styles.rowText}>
          <Text style={settingsStyles.rowTitle}>
            {t("settings.appearance.background.visibility.title")}
          </Text>
          <Text style={settingsStyles.rowHint}>
            {t("settings.appearance.background.visibility.hint")}
          </Text>
        </View>
        <SegmentedControl
          size="sm"
          options={VISIBILITY_OPTIONS}
          value={`${nearestVisibilityPercent(preferences.visibility)}`}
          onValueChange={handleVisibilityChange}
          testID="settings-background-visibility"
        />
      </View>
      <View style={[styles.stackedRow, settingsStyles.rowBorder]}>
        <View style={styles.rowText}>
          <Text style={settingsStyles.rowTitle}>
            {t("settings.appearance.background.blur.title")}
          </Text>
        </View>
        <SegmentedControl
          size="sm"
          options={blurOptions}
          value={preferences.blur}
          onValueChange={setSkinBlur}
          testID="settings-background-blur"
        />
      </View>
      <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>
            {t("settings.appearance.background.showBehindSidebar")}
          </Text>
        </View>
        <Switch
          value={preferences.showBehindSidebar}
          onValueChange={setSkinShowBehindSidebar}
          accessibilityLabel={t("settings.appearance.background.showBehindSidebar")}
          testID="settings-background-behind-sidebar"
        />
      </View>
      <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>
            {t("settings.appearance.background.showBehindContent")}
          </Text>
        </View>
        <Switch
          value={preferences.showBehindContent}
          onValueChange={setSkinShowBehindContent}
          accessibilityLabel={t("settings.appearance.background.showBehindContent")}
          testID="settings-background-behind-content"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  stackedRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
  },
  rowText: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 200,
  },
}));
