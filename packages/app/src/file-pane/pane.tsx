import { usePaneContext } from "@/panels/pane-context";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { PluginFile, PluginTab } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import { Download } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useFileHandle, useFileHandleSnapshot } from "@/file-panels/file";
import { FilePanelLoading } from "@/file-panels/loading";
import { FilePanelPicker, FilePanelView, useFilePanelChoice, type FilePanel } from "@/file-panels";
import { resolveFilePreviewReadTarget } from "@/file-explorer/preview-target";
import { useFileDownload } from "@/hooks/use-file-download";
import { SendToButton } from "@/send-to/send-to-button";
import { useAppActivelyVisible } from "@/hooks/use-app-visible";
import { useAppSettings } from "@/hooks/use-settings";
import { useHostCopy } from "@/offline-files/host-copy";
import { useOfflineFiles, type OfflineFile } from "@/offline-files/store";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { usePublishPanelInstanceAttributes } from "@/panels/panel-instance-attributes";
import { useSessionStore } from "@/stores/session-store";
import { buildAbsoluteExplorerPath } from "@/utils/explorer-paths";
import { formatFileSize } from "@/utils/format-file-size";
import { OfflineCopyBar } from "@/offline-files/copy-bar";
import type { WorkspaceFileLocation } from "@/workspace/file-open";

/**
 * The file tab: stats the file, picks its panel and mounts it. The panel reads, saves and shows
 * its own loading; the tab only knows the file exists, its kind, and whether the panel has
 * unsaved changes.
 */
export function FilePane({
  serverId,
  workspaceId,
  workspaceRoot,
  location,
  navigationRevision,
}: {
  serverId: string;
  workspaceId?: string | null;
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
  const downloadFile = useFileDownload({
    serverId,
    workspaceId,
    workspaceRoot: target?.cwd ?? root,
  });
  const handleDownload = useCallback(() => {
    if (target) {
      downloadFile({ fileName: path.split(/[\\/]/).pop() ?? path, path: target.path });
    }
  }, [downloadFile, path, target]);
  const absolutePath = useMemo(
    () => buildAbsoluteExplorerPath({ workspaceRoot: root, entryPath: path }),
    [path, root],
  );
  // A hidden tab or a backgrounded app stops observing; observing again reports what changed.
  const isActive = useRetainedPanelActive();
  const isAppVisible = useAppActivelyVisible();
  const { offlineCopy, hostCopy } = useOfflineStandIn({
    serverId,
    absolutePath,
    connected,
    hasTarget: target !== null,
  });
  const { settings } = useAppSettings();
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

  const offlineBar = <OfflineCopyBarFor entry={offlineCopy} />;
  let body;
  if (hostCopy === "tooLarge") {
    body = (
      <Text style={styles.errorText}>
        {t("offlineFiles.tooLarge", { size: settings.offlineFilesMaxFileMb })}
      </Text>
    );
  } else if (!connected && !offlineCopy && target && hostCopy !== "loading") {
    body = <Text style={styles.errorText}>{t("workspace.terminal.hostDisconnected")}</Text>;
  } else if (!handle || snapshot.status === "loading" || hostCopy === "loading") {
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
        <Button variant="outline" onPress={handle.retry}>
          {t("common.actions.retry")}
        </Button>
      </>
    );
  } else if (!panel) {
    body = (
      <>
        <Text style={styles.mutedText}>{t("panels.file.binaryPreviewUnavailable")}</Text>
        <Text style={styles.mutedText}>{formatFileSize(snapshot.size)}</Text>
        <Button variant="outline" leftIcon={Download} onPress={handleDownload}>
          {t("workspace.fileActions.download")}
        </Button>
        <SendToButton serverId={serverId} absolutePath={absolutePath} />
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

/**
 * With the host offline, a saved copy stands in for the file: this device's own, else the one
 * another host keeps.
 */
function useOfflineStandIn(input: {
  serverId: string;
  absolutePath: string;
  connected: boolean;
  hasTarget: boolean;
}) {
  const { serverId, absolutePath, hasTarget } = input;
  const hostConnected = useHostRuntimeIsConnected(serverId);
  const online = input.connected && hostConnected;
  const offlineFiles = useOfflineFiles();
  const offlineCopy = useMemo(
    () =>
      online
        ? null
        : (offlineFiles?.find(
            (entry) => entry.serverId === serverId && entry.path === absolutePath,
          ) ?? null),
    [absolutePath, offlineFiles, online, serverId],
  );
  const hostCopy = useHostCopy({
    serverId,
    path: absolutePath,
    enabled: !online && offlineFiles !== null && !offlineCopy && hasTarget,
  });
  return { offlineCopy, hostCopy };
}

function OfflineCopyBarFor({ entry }: { entry: OfflineFile | null }) {
  return entry ? <OfflineCopyBar entry={entry} /> : null;
}

const ignoreModified = () => {};

/**
 * A saved copy on its own, outside any workspace: the Saved screen's file view. It always reads
 * this device's copy, so it opens with every host asleep. The caller provides the pane context.
 */
export function SavedFilePane({ entry }: { entry: OfflineFile }) {
  const { t } = useTranslation();
  const target = useMemo(() => resolveFilePreviewReadTarget({ path: entry.path }), [entry.path]);
  const handle = useFileHandle({
    serverId: entry.serverId,
    target,
    absolutePath: entry.path,
    observing: true,
    offlineCopy: entry,
  });
  const snapshot = useFileHandleSnapshot(handle);
  const targetKey = target ? `${target.cwd}:${target.path}` : null;
  const { panel, choice } = useFilePanelChoice({
    serverId: entry.serverId,
    targetKey,
    path: entry.path,
    fileKind: snapshot.status === "ready" ? snapshot.kind : null,
    presentable: true,
    lineNavigation: null,
  });
  const params = useMemo(() => ({ path: entry.path }), [entry.path]);

  let body;
  if (!handle || snapshot.status === "loading") {
    body = <FilePanelLoading />;
  } else if (snapshot.status === "missing" || snapshot.status === "error") {
    body = (
      <View style={styles.centerState}>
        <Text style={styles.errorText}>
          {snapshot.status === "error" ? snapshot.error : t("panels.file.notFound")}
        </Text>
      </View>
    );
  } else if (!panel) {
    body = (
      <View style={styles.centerState}>
        <Text style={styles.mutedText}>{t("panels.file.binaryPreviewUnavailable")}</Text>
        <Text style={styles.mutedText}>{formatFileSize(snapshot.size)}</Text>
      </View>
    );
  } else {
    body = (
      <>
        <FilePanelPicker choice={choice} />
        <MountedFilePanel
          key={`${panel.id}:${targetKey}`}
          panel={panel}
          file={handle.file}
          params={params}
          revision={0}
          onModifiedChange={ignoreModified}
        />
      </>
    );
  }
  return (
    <View style={styles.container} testID="saved-file-pane">
      <OfflineCopyBar entry={entry} />
      {body}
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
    backgroundColor: theme.colors.canvas,
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
  mutedText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
}));
