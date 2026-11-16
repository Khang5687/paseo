import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
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
import { useHosts } from "@/runtime/host-runtime";
import { groupSavedFiles } from "./saved-list";
import {
  clearOfflineFiles,
  pruneOfflineFiles,
  removeOfflineFile,
  useOfflineFiles,
  type OfflineFile,
} from "./store";

// Past this many saved files the list gets a search box.
const SEARCH_AFTER_FILES = 20;

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

  const hosts = useHosts();
  const hostLabels = useMemo(
    () => new Map(hosts.map((host) => [host.serverId, host.label])),
    [hosts],
  );
  const [query, setQuery] = useState("");
  const searchable = (files?.length ?? 0) > SEARCH_AFTER_FILES;
  const groups = useMemo(
    () =>
      groupSavedFiles(files ?? [], {
        query: searchable ? query : "",
        hostOrder: hosts.map((host) => host.serverId),
      }),
    [files, hosts, query, searchable],
  );
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
          <NumberLimitRow
            key={key}
            label={t(`offlineFiles.${text}.label`)}
            hint={t(`offlineFiles.${text}.description`)}
            value={settings[key]}
            bounds={LIMIT_BOUNDS[key]}
            onCommit={(value) => void changeLimit(key, value)}
            testID={`offline-files-${key}`}
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
        {searchable ? (
          <View style={styles.searchRow}>
            <FormTextInput
              size="sm"
              initialValue={query}
              onChangeText={setQuery}
              placeholder={t("offlineFiles.search")}
              accessibilityLabel={t("offlineFiles.search")}
              autoCapitalize="none"
              autoCorrect={false}
              testID="offline-files-search"
            />
          </View>
        ) : null}
        {groups.map((group) => (
          <View key={group.serverId} testID={`offline-files-host-${group.serverId}`}>
            <View style={styles.hostRow}>
              <Text style={styles.hostName} numberOfLines={1}>
                {hostLabels.get(group.serverId) ?? group.serverId}
              </Text>
              <Text style={styles.fileMeta}>{formatFileSize(group.totalBytes)}</Text>
            </View>
            {group.files.map((file) => (
              <SavedFileRow key={file.path} file={file} />
            ))}
          </View>
        ))}
        {searchable && groups.length === 0 ? (
          <Text style={[styles.filePath, styles.noMatches]}>{t("offlineFiles.noMatches")}</Text>
        ) : null}
      </SettingsCard>
    </SettingsSection>
  );
}

/** Long-press removes the saved copy, after a confirm. */
function SavedFileRow({ file }: { file: OfflineFile }) {
  const { t } = useTranslation();
  const name = file.path.split(/[\\/]/).pop() ?? file.path;
  const remove = useCallback(async () => {
    const confirmed = await confirmDialog({
      title: t("offlineFiles.removeConfirmTitle", { name }),
      message: t("offlineFiles.removeConfirmMessage"),
      confirmLabel: t("offlineFiles.remove"),
      destructive: true,
    });
    if (confirmed) await removeOfflineFile(file.serverId, file.path);
  }, [file.path, file.serverId, name, t]);
  return (
    <Pressable
      onLongPress={remove}
      accessibilityHint={t("offlineFiles.removeHint")}
      accessibilityActions={[{ name: "remove", label: t("offlineFiles.remove") }]}
      onAccessibilityAction={remove}
      style={styles.fileRow}
      testID="offline-files-row"
    >
      <View style={styles.fileText}>
        <Text style={styles.fileName} numberOfLines={1}>
          {name}
        </Text>
        <Text style={styles.filePath} numberOfLines={1} ellipsizeMode="middle">
          {file.path}
        </Text>
      </View>
      <Text style={styles.fileMeta}>
        {formatFileSize(file.size)} · {formatTimeAgo(new Date(file.savedAt))}
      </Text>
    </Pressable>
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
  searchRow: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  hostRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[1],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  hostName: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  noMatches: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
}));
