import { useCallback } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  previewSkinBlur,
  previewSkinVisibility,
  setSkinBlur,
  setSkinShowBehindContent,
  setSkinShowBehindSidebar,
  setSkinVisibility,
  SKIN_BLUR_MAX,
  useSkinBlur,
  useSkinPreferences,
  useSkinVisibility,
} from "@/skins";
import { settingsStyles } from "@/styles/settings";

function formatPercent(percent: number): string {
  return `${percent}%`;
}

function previewVisibilityPercent(percent: number): void {
  previewSkinVisibility(percent / 100);
}

function commitVisibilityPercent(percent: number): void {
  setSkinVisibility(percent / 100);
}

export function BackgroundControls() {
  const { t } = useTranslation();
  const preferences = useSkinPreferences();
  const visibilityPercent = Math.round(useSkinVisibility() * 100);
  const blur = Math.round(useSkinBlur());

  const formatBlur = useCallback(
    (radius: number) =>
      radius === 0
        ? t("settings.appearance.background.blur.off")
        : t("settings.appearance.background.blur.value", { radius }),
    [t],
  );

  return (
    <View style={settingsStyles.card}>
      <View style={styles.sliderRow}>
        <View style={styles.sliderHeader}>
          <Text style={settingsStyles.rowTitle}>
            {t("settings.appearance.background.visibility.title")}
          </Text>
          <Text style={styles.sliderValue}>{formatPercent(visibilityPercent)}</Text>
        </View>
        <Text style={settingsStyles.rowHint}>
          {t("settings.appearance.background.visibility.hint")}
        </Text>
        <Slider
          value={visibilityPercent}
          min={0}
          max={100}
          onValueChange={previewVisibilityPercent}
          onSlidingComplete={commitVisibilityPercent}
          formatValue={formatPercent}
          accessibilityLabel={t("settings.appearance.background.visibility.title")}
          testID="settings-background-visibility"
        />
      </View>
      <View style={[styles.sliderRow, settingsStyles.rowBorder]}>
        <View style={styles.sliderHeader}>
          <Text style={settingsStyles.rowTitle}>
            {t("settings.appearance.background.blur.title")}
          </Text>
          <Text style={styles.sliderValue}>{formatBlur(blur)}</Text>
        </View>
        <Slider
          value={blur}
          min={0}
          max={SKIN_BLUR_MAX}
          onValueChange={previewSkinBlur}
          onSlidingComplete={setSkinBlur}
          formatValue={formatBlur}
          accessibilityLabel={t("settings.appearance.background.blur.title")}
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
  sliderRow: {
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
  },
  sliderHeader: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  sliderValue: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
}));
