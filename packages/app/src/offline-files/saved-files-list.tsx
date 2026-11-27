import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { router } from "expo-router";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { FormTextInput } from "@/components/ui/form-field";
import { useHosts } from "@/runtime/host-runtime";
import { confirmDialog } from "@/utils/confirm-dialog";
import { formatFileSize } from "@/utils/format-file-size";
import { buildSavedFileRoute } from "@/utils/host-routes";
import { SavedFileRow } from "./saved-file-row";
import { groupSavedFiles, type SavedFileItem } from "./saved-list";
import { removeOfflineFiles, type OfflineFile } from "./store";
import { useSavedFileItems } from "./use-saved-file-items";

// Past this many saved files the list gets a search box.
const SEARCH_AFTER_FILES = 20;

/**
 * Settings → Files: this device's saved files grouped by host, with each host's total, and a
 * search box once the list is long. A tap opens the saved copy; a long-press removes it after a
 * confirm. The Saved screen has the full browser (`saved-browser.tsx`).
 */
export function SavedFilesList({ files }: { files: readonly OfflineFile[] }) {
  const { t } = useTranslation();
  const hosts = useHosts();
  const items = useSavedFileItems(files);
  const itemByFile = useMemo(() => new Map(items.map((item) => [item.file, item])), [items]);
  const [query, setQuery] = useState("");
  const searchable = files.length > SEARCH_AFTER_FILES;
  const groups = useMemo(
    () =>
      groupSavedFiles(files, {
        query: searchable ? query : "",
        hostOrder: hosts.map((host) => host.serverId),
      }),
    [files, hosts, query, searchable],
  );

  return (
    <View>
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
      {groups.map((group, index) => (
        <View key={group.serverId} testID={`offline-files-host-${group.serverId}`}>
          <View style={[styles.hostRow, (index > 0 || searchable) && styles.divider]}>
            <Text style={styles.hostName} numberOfLines={1}>
              {hosts.find((host) => host.serverId === group.serverId)?.label ?? group.serverId}
            </Text>
            <Text style={styles.fileMeta}>{formatFileSize(group.totalBytes)}</Text>
          </View>
          {group.files.map((file) => {
            const item = itemByFile.get(file);
            return item ? <RemovableRow key={file.path} item={item} /> : null;
          })}
        </View>
      ))}
      {searchable && groups.length === 0 ? (
        <Text style={[styles.fileMeta, styles.noMatches]}>{t("offlineFiles.noMatches")}</Text>
      ) : null}
    </View>
  );
}

function RemovableRow({ item }: { item: SavedFileItem }) {
  const { t } = useTranslation();
  const { file, name } = item;
  const open = useCallback(() => {
    router.push(buildSavedFileRoute({ serverId: file.serverId, path: file.path }));
  }, [file.path, file.serverId]);
  const remove = useCallback(async () => {
    const confirmed = await confirmDialog({
      title: t("offlineFiles.removeConfirmTitle", { name }),
      message: t("offlineFiles.removeConfirmMessage"),
      confirmLabel: t("offlineFiles.remove"),
      destructive: true,
    });
    if (confirmed) await removeOfflineFiles([file]);
  }, [file, name, t]);
  return (
    <SavedFileRow
      item={item}
      onPress={open}
      showDevice={false}
      onLongPress={remove}
      accessibilityHint={t("offlineFiles.removeHint")}
      accessibilityActions={[{ name: "remove", label: t("offlineFiles.remove") }]}
      onAccessibilityAction={remove}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  divider: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  fileMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  searchRow: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
  },
  hostRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[1],
  },
  hostName: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  noMatches: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
}));
