import { useMemo } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { ExternalLink } from "@/components/ui/external-link";
import type { SkinSummary } from "@/skins";
import { isHttpUrl } from "@/utils/http-url";

interface SkinDetailsSheetProps {
  skin: SkinSummary | null;
  onClose: () => void;
}

interface DetailRowProps {
  label: string;
  children: string;
}

function DetailRow({ label, children }: DetailRowProps) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value} selectable>
        {children}
      </Text>
    </View>
  );
}

export function SkinDetailsSheet({ skin, onClose }: SkinDetailsSheetProps) {
  const { t } = useTranslation();
  const header = useMemo<SheetHeader>(
    () => ({
      title: skin?.name ?? t("settings.appearance.background.details.title"),
    }),
    [skin?.name, t],
  );
  const attribution = skin?.attribution ?? null;
  const sourceUrl =
    attribution?.sourceUrl && isHttpUrl(attribution.sourceUrl) ? attribution.sourceUrl : null;

  return (
    <AdaptiveModalSheet
      visible={skin !== null}
      onClose={onClose}
      header={header}
      testID="settings-background-details-sheet"
    >
      <View style={styles.body}>
        {attribution?.author ? (
          <DetailRow label={t("settings.appearance.background.details.author")}>
            {attribution.author}
          </DetailRow>
        ) : null}
        {attribution?.license ? (
          <DetailRow label={t("settings.appearance.background.details.license")}>
            {attribution.license}
          </DetailRow>
        ) : null}
        {sourceUrl ? (
          <View style={styles.row}>
            <Text style={styles.label}>{t("settings.appearance.background.details.source")}</Text>
            <ExternalLink
              href={sourceUrl}
              label={t("settings.appearance.background.details.openSource")}
            />
          </View>
        ) : null}
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  row: {
    gap: theme.spacing[1],
    alignItems: "flex-start",
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  value: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
}));
