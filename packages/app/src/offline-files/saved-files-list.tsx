import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { router } from "expo-router";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { MaterialFileIcon } from "@/components/material-file-icon";
import { FormTextInput } from "@/components/ui/form-field";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useHosts } from "@/runtime/host-runtime";
import { confirmDialog } from "@/utils/confirm-dialog";
import { formatFileSize } from "@/utils/format-file-size";
import { buildSavedFileRoute } from "@/utils/host-routes";
import { formatTimeAgo } from "@/utils/time";
import { groupSavedFiles } from "./saved-list";
import { removeOfflineFile, type OfflineFile } from "./store";

// Past this many saved files the list gets a search box.
const SEARCH_AFTER_FILES = 20;
const FILE_ICON_SIZE = 20;

/**
 * This device's saved files grouped by host, with a search box once the list is long. A tap opens
 * the saved copy; a long-press removes it after a confirm. Settings → Files and the Saved screen
 * both show this list.
 */
export function SavedFilesList({ files }: { files: readonly OfflineFile[] }) {
  const { t } = useTranslation();
  const hosts = useHosts();
  const hostLabels = useMemo(
    () => new Map(hosts.map((host) => [host.serverId, host.label])),
    [hosts],
  );
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
    </View>
  );
}

function SavedFileRow({ file }: { file: OfflineFile }) {
  const { t } = useTranslation();
  const name = file.path.split(/[\\/]/).pop() ?? file.path;
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
    if (confirmed) await removeOfflineFile(file.serverId, file.path);
  }, [file.path, file.serverId, name, t]);
  return (
    <PressHighlight
      onPress={open}
      onLongPress={remove}
      accessibilityRole="button"
      accessibilityLabel={name}
      accessibilityHint={t("offlineFiles.removeHint")}
      accessibilityActions={[{ name: "remove", label: t("offlineFiles.remove") }]}
      onAccessibilityAction={remove}
      style={[styles.fileRow, styles.divider]}
      testID="offline-files-row"
    >
      <MaterialFileIcon fileName={name} size={FILE_ICON_SIZE} />
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
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  divider: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  fileRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
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
