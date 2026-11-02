import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { SettingsCard, SettingsRow, SettingsSection, SettingsSwitch } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import {
  OFFLINE_FILE_LIMITS,
  parseClampedFontSize,
  useAppSettings,
  type AppSettings,
} from "@/hooks/use-settings";
import { confirmDialog } from "@/utils/confirm-dialog";
import { formatFileSize } from "@/utils/format-file-size";
import { formatTimeAgo } from "@/utils/time";
import { clearOfflineFiles, pruneOfflineFiles, useOfflineFiles } from "./store";

// The newest files are the ones worth listing; the summary row counts the rest.
const LISTED_FILES = 20;

type LimitKey = "offlineFilesRetentionDays" | "offlineFilesMaxTotalMb" | "offlineFilesMaxFileMb";
const LIMIT_BOUNDS: Record<LimitKey, { min: number; max: number }> = {
  offlineFilesRetentionDays: OFFLINE_FILE_LIMITS.retentionDays,
  offlineFilesMaxTotalMb: OFFLINE_FILE_LIMITS.maxTotalMb,
  offlineFilesMaxFileMb: OFFLINE_FILE_LIMITS.maxFileMb,
};

/** Saved copies of chat files: the automatic-saving toggle, the limits, and what is saved. */
export function OfflineFilesSection() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const files = useOfflineFiles();
  const changeAutoSave = useCallback(
    (offlineFilesAutoSave: boolean) => void updateSettings({ offlineFilesAutoSave }),
    [updateSettings],
  );
  const changeLimit = useCallback(
    async (key: LimitKey, value: number) => {
      const next: AppSettings = { ...settings, [key]: value };
      await updateSettings({ [key]: value });
      await pruneOfflineFiles(next);
    },
    [settings, updateSettings],
  );
  const clearAll = useCallback(async () => {
    const confirmed = await confirmDialog({
      title: t("offlineFiles.clearConfirmTitle"),
      message: t("offlineFiles.clearConfirmMessage"),
      confirmLabel: t("offlineFiles.clearAll"),
      destructive: true,
    });
    if (confirmed) await clearOfflineFiles();
  }, [t]);

  const totalBytes = files?.reduce((sum, file) => sum + file.size, 0) ?? 0;
  const newest = [...(files ?? [])].sort((a, b) => b.savedAt - a.savedAt).slice(0, LISTED_FILES);

  return (
    <SettingsSection title={t("offlineFiles.title")} testID="offline-files-settings">
      <SettingsCard>
        <SettingsSwitch
          label={t("offlineFiles.autoSave.label")}
          hint={t("offlineFiles.autoSave.description")}
          value={settings.offlineFilesAutoSave}
          onValueChange={changeAutoSave}
        />
        <LimitRow
          settingKey="offlineFilesRetentionDays"
          label={t("offlineFiles.retentionDays.label")}
          hint={t("offlineFiles.retentionDays.description")}
          value={settings.offlineFilesRetentionDays}
          onCommit={changeLimit}
        />
        <LimitRow
          settingKey="offlineFilesMaxTotalMb"
          label={t("offlineFiles.maxTotalMb.label")}
          hint={t("offlineFiles.maxTotalMb.description")}
          value={settings.offlineFilesMaxTotalMb}
          onCommit={changeLimit}
        />
        <LimitRow
          settingKey="offlineFilesMaxFileMb"
          label={t("offlineFiles.maxFileMb.label")}
          hint={t("offlineFiles.maxFileMb.description")}
          value={settings.offlineFilesMaxFileMb}
          onCommit={changeLimit}
        />
      </SettingsCard>
      <SettingsCard>
        <SettingsRow
          label={t("offlineFiles.saved.label", {
            count: files?.length ?? 0,
            size: formatFileSize(totalBytes),
          })}
          hint={t("offlineFiles.saved.description")}
          testID="offline-files-summary"
        >
          <Button
            variant="destructive"
            size="sm"
            disabled={!files || files.length === 0}
            onPress={clearAll}
            testID="offline-files-clear"
          >
            {t("offlineFiles.clearAll")}
          </Button>
        </SettingsRow>
        {newest.map((file) => (
          <View key={`${file.serverId}\n${file.path}`} style={styles.fileRow}>
            <View style={styles.fileText}>
              <Text style={styles.fileName} numberOfLines={1}>
                {file.path.split(/[\\/]/).pop()}
              </Text>
              <Text style={styles.filePath} numberOfLines={1} ellipsizeMode="middle">
                {file.path}
              </Text>
            </View>
            <Text style={styles.fileMeta}>
              {formatFileSize(file.size)} · {formatTimeAgo(new Date(file.savedAt))}
            </Text>
          </View>
        ))}
      </SettingsCard>
    </SettingsSection>
  );
}

function LimitRow({
  settingKey,
  label,
  hint,
  value,
  onCommit,
}: {
  settingKey: LimitKey;
  label: string;
  hint: string;
  value: number;
  onCommit: (key: LimitKey, value: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const changeText = useCallback((next: string) => setText(next.replace(/[^\d]/g, "")), []);
  const commit = useCallback(() => {
    const next = parseClampedFontSize(text, LIMIT_BOUNDS[settingKey]) ?? value;
    setText(String(next));
    if (next !== value) onCommit(settingKey, next);
  }, [onCommit, settingKey, text, value]);
  return (
    <SettingsRow label={label} hint={hint}>
      <FormTextInput
        size="sm"
        initialValue={text}
        onChangeText={changeText}
        onBlur={commit}
        onSubmitEditing={commit}
        keyboardType="number-pad"
        inputMode="numeric"
        selectTextOnFocus
        style={styles.numberInput}
        accessibilityLabel={label}
        testID={`offline-files-${settingKey}`}
      />
    </SettingsRow>
  );
}

const styles = StyleSheet.create((theme) => ({
  numberInput: {
    width: 96,
    textAlign: "right",
  },
  fileRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  fileText: {
    flex: 1,
    minWidth: 0,
  },
  fileName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  filePath: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  fileMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
