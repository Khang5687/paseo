import { useCallback, useEffect, useState } from "react";
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
import { SavedFilesList } from "./saved-files-list";
import { clearOfflineFiles, pruneOfflineFiles, useOfflineFiles } from "./store";

type LimitKey = "offlineFilesRetentionDays" | "offlineFilesMaxTotalMb" | "offlineFilesMaxFileMb";
const LIMIT_BOUNDS: Record<LimitKey, { min: number; max: number }> = {
  offlineFilesRetentionDays: OFFLINE_FILE_LIMITS.retentionDays,
  offlineFilesMaxTotalMb: OFFLINE_FILE_LIMITS.maxTotalMb,
  offlineFilesMaxFileMb: OFFLINE_FILE_LIMITS.maxFileMb,
};
const LIMIT_KEYS = [
  { key: "offlineFilesRetentionDays", text: "retentionDays" },
  { key: "offlineFilesMaxTotalMb", text: "maxTotalMb" },
  { key: "offlineFilesMaxFileMb", text: "maxFileMb" },
] as const;

/** Saved copies of chat files: the automatic-saving toggle, the limits, and what is saved. */
export function OfflineFilesSection() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const files = useOfflineFiles();
  const changeAutoSave = useCallback(
    (offlineFilesAutoSave: boolean) => void updateSettings({ offlineFilesAutoSave }),
    [updateSettings],
  );
  const changeWifiOnly = useCallback(
    (offlineFilesWifiOnly: boolean) => void updateSettings({ offlineFilesWifiOnly }),
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

  return (
    <SettingsSection title={t("offlineFiles.title")} testID="offline-files-settings">
      <SettingsCard>
        <SettingsSwitch
          label={t("offlineFiles.autoSave.label")}
          hint={t("offlineFiles.autoSave.description")}
          value={settings.offlineFilesAutoSave}
          onValueChange={changeAutoSave}
        />
        <SettingsSwitch
          label={t("offlineFiles.wifiOnly.label")}
          hint={t("offlineFiles.wifiOnly.description")}
          value={settings.offlineFilesWifiOnly}
          onValueChange={changeWifiOnly}
          testID="offline-files-wifi-only"
        />
        {LIMIT_KEYS.map(({ key, text }) => (
          <AppLimitRow
            key={key}
            limitKey={key}
            text={text}
            value={settings[key]}
            onChange={changeLimit}
          />
        ))}
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
        {files && files.length > 0 ? <SavedFilesList files={files} /> : null}
      </SettingsCard>
    </SettingsSection>
  );
}

function AppLimitRow({
  limitKey,
  text,
  value,
  onChange,
}: {
  limitKey: LimitKey;
  text: (typeof LIMIT_KEYS)[number]["text"];
  value: number;
  onChange: (key: LimitKey, value: number) => Promise<void>;
}) {
  const { t } = useTranslation();
  const commit = useCallback((next: number) => void onChange(limitKey, next), [limitKey, onChange]);
  return (
    <NumberLimitRow
      label={t(`offlineFiles.${text}.label`)}
      hint={t(`offlineFiles.${text}.description`)}
      value={value}
      bounds={LIMIT_BOUNDS[limitKey]}
      onCommit={commit}
      testID={`offline-files-${limitKey}`}
    />
  );
}

/** A whole-number limit, clamped to `bounds` and committed on blur or submit. */
export function NumberLimitRow({
  label,
  hint,
  value,
  bounds,
  onCommit,
  testID,
}: {
  label: string;
  hint: string;
  value: number;
  bounds: { min: number; max: number };
  onCommit: (value: number) => void;
  testID: string;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const changeText = useCallback((next: string) => setText(next.replace(/[^\d]/g, "")), []);
  const commit = useCallback(() => {
    const next = parseClampedFontSize(text, bounds) ?? value;
    setText(String(next));
    if (next !== value) onCommit(next);
  }, [bounds, onCommit, text, value]);
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
        testID={testID}
      />
    </SettingsRow>
  );
}

const styles = StyleSheet.create({
  numberInput: {
    width: 96,
    textAlign: "right",
  },
});
