import { usePaneContext } from "@/panels/pane-context";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Share2 } from "lucide-react-native";
import type { PluginFile, PluginTab } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useFileHandle, useFileHandleSnapshot } from "@/file-panels/file";
import { FilePanelLoading } from "@/file-panels/loading";
import { FilePanelPicker, FilePanelView, useFilePanelChoice, type FilePanel } from "@/file-panels";
import { resolveFilePreviewReadTarget } from "@/file-explorer/preview-target";
import { useAppActivelyVisible } from "@/hooks/use-app-visible";
import { readOfflineFileBytes, useOfflineFiles, type OfflineFile } from "@/offline-files/store";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { shareFileBytes } from "@/stores/download-store";
import { usePublishPanelInstanceAttributes } from "@/panels/panel-instance-attributes";
import { useSessionStore } from "@/stores/session-store";
import { buildAbsoluteExplorerPath } from "@/utils/explorer-paths";
import { formatFileSize } from "@/utils/format-file-size";
import { formatTimeAgo } from "@/utils/time";
import type { WorkspaceFileLocation } from "@/workspace/file-open";

/**
 * The file tab: stats the file, picks its panel and mounts it. The panel reads, saves and shows
 * its own loading; the tab only knows the file exists, its kind, and whether the panel has
 * unsaved changes.
 */
export function FilePane({
  serverId,
  workspaceRoot,
  location,
  navigationRevision,
}: {
  serverId: string;
  workspaceRoot: string;
  location: WorkspaceFileLocation;
  navigationRevision: number;
}) {
  const { t } = useTranslation();
  const connected = useSessionStore((state) => Boolean(state.sessions[serverId]?.client));
  const root = workspaceRoot.trim();
  const path = location.path.trim();
  const target = useMemo(
    () => (path ? resolveFilePreviewReadTarget({ path, workspaceRoot: root }) : null),
    [path, root],
  );
  const absolutePath = useMemo(
    () => buildAbsoluteExplorerPath({ workspaceRoot: root, entryPath: path }),
    [path, root],
  );
  // A hidden tab or a backgrounded app stops observing; observing again reports what changed.
  const isActive = useRetainedPanelActive();
  const isAppVisible = useAppActivelyVisible();
  // With the host offline, a saved copy stands in for the file.
  const hostConnected = useHostRuntimeIsConnected(serverId);
  const offlineFiles = useOfflineFiles();
  const offlineCopy = useMemo(
    () =>
      connected && hostConnected
        ? null
        : (offlineFiles?.find(
            (entry) => entry.serverId === serverId && entry.path === absolutePath,
          ) ?? null),
    [absolutePath, connected, hostConnected, offlineFiles, serverId],
  );
  const handle = useFileHandle({
    serverId,
    target,
    absolutePath,
    observing: isActive && isAppVisible,
    offlineCopy,
  });
  const snapshot = useFileHandleSnapshot(handle);
  const targetKey = target ? `${target.cwd}:${target.path}` : null;
  const { panel, choice } = useFilePanelChoice({
    serverId,
    targetKey,
    path,
    fileKind: snapshot.status === "ready" ? snapshot.kind : null,
    presentable: isActive,
    lineNavigation: location.lineStart ? navigationRevision : null,
  });
  const [modified, setModified] = useState(false);
  usePublishPanelInstanceAttributes({ modified, suspendPendingSave: handle?.holdWrites });
  const panelLocation = useMemo(
    () => ({
      lineStart: location.lineStart,
      lineEnd: location.lineEnd,
      path,
    }),
    [location.lineEnd, location.lineStart, path],
  );

  const offlineBar = offlineCopy ? <OfflineCopyBar entry={offlineCopy} /> : null;
  let body;
  if (!connected && !offlineCopy && target) {
    body = <Text style={styles.errorText}>{t("workspace.terminal.hostDisconnected")}</Text>;
  } else if (!handle || snapshot.status === "loading") {
    return (
      <View style={styles.container} testID="workspace-file-pane">
        <FilePanelLoading />
      </View>
    );
  } else if (snapshot.status === "missing" || snapshot.status === "error") {
    body = (
      <>
        <Text style={styles.errorText}>
          {snapshot.status === "error" ? snapshot.error : t("panels.file.notFound")}
        </Text>
        <Button variant="outline" size="sm" onPress={handle.retry}>
          {t("common.actions.retry")}
        </Button>
      </>
    );
  } else if (!panel) {
    body = (
      <>
        <Text style={styles.mutedText}>{t("panels.file.binaryPreviewUnavailable")}</Text>
        <Text style={styles.mutedText}>{formatFileSize(snapshot.size)}</Text>
      </>
    );
  } else {
    return (
      <View style={styles.container} testID="workspace-file-pane">
        {offlineBar}
        <FilePanelPicker choice={choice} />
        <MountedFilePanel
          key={`${panel.id}:${targetKey}`}
          panel={panel}
          file={handle.file}
          params={panelLocation}
          revision={navigationRevision}
          onModifiedChange={setModified}
        />
      </View>
    );
  }
  return (
    <View style={styles.container} testID="workspace-file-pane">
      {offlineBar}
      <View style={styles.centerState}>{body}</View>
    </View>
  );
}

/** Says the file is a saved copy and how old it is, and hands it to other apps. */
function OfflineCopyBar({ entry }: { entry: OfflineFile }) {
  const { t } = useTranslation();
  const share = useCallback(async () => {
    await shareFileBytes({
      bytes: await readOfflineFileBytes(entry),
      fileName: entry.path.split(/[\\/]/).pop() ?? "file",
      mimeType: entry.mimeType,
    });
  }, [entry]);
  return (
    <View style={styles.offlineBar} testID="offline-file-bar">
      <Text style={styles.offlineText} numberOfLines={1}>
        {t("offlineFiles.savedAgo", { time: formatTimeAgo(new Date(entry.savedAt)) })}
      </Text>
      <Button
        variant="ghost"
        size="sm"
        leftIcon={Share2}
        onPress={share}
        testID="offline-file-share"
      >
        {t("offlineFiles.share")}
      </Button>
    </View>
  );
}

/** One panel mount. Its tab reports unsaved changes until the panel unmounts. */
function MountedFilePanel({
  panel,
  file,
  params,
  revision,
  onModifiedChange,
}: {
  panel: FilePanel;
  file: PluginFile;
  params: { path: string; lineStart?: number; lineEnd?: number };
  revision: number;
  onModifiedChange: (modified: boolean) => void;
}) {
  const { state, setCurrentTabState } = usePaneContext();
  const tab = useMemo<PluginTab>(
    () => ({
      setModified: onModifiedChange,
      state,
      setState: setCurrentTabState,
    }),
    [onModifiedChange, state, setCurrentTabState],
  );
  useEffect(() => () => onModifiedChange(false), [onModifiedChange]);
  return <FilePanelView panel={panel} file={file} tab={tab} params={params} revision={revision} />;
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[4],
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  offlineBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  offlineText: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  mutedText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
}));
