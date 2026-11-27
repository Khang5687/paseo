import { useCallback, useEffect, useMemo } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Check, X, XCircle } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import {
  HEADER_INNER_HEIGHT,
  HEADER_INNER_HEIGHT_MOBILE,
  HEADER_TOP_PADDING_MOBILE,
  useIsCompactFormFactor,
} from "@/constants/layout";
import { getIsElectronMac } from "@/constants/platform";
import { useToast } from "@/contexts/toast-context";
import { canInstallPackage, installSavedPackage } from "@/downloads/install-package";
import { canRevealSavedFile, revealSavedFile } from "@/downloads/reveal-file";
import { OVERLAY_Z } from "@/lib/overlay-root";
import { getOfflineFile } from "@/offline-files/store";
import { useDownloadStore, type Download } from "@/stores/download-store";
import { SPACING, type Theme } from "@/styles/theme";
import { buildSavedFileRoute } from "@/utils/host-routes";

const AUTO_DISMISS_DELAY = 3000;
// Long enough to reach Open, Install or "Show in folder".
const ACTION_DISMISS_DELAY = 8000;

const ThemedCheck = withUnistyles(Check);
const ThemedXCircle = withUnistyles(XCircle);
const successIcon = (theme: Theme) => ({ color: theme.colors.primary });
const errorIcon = (theme: Theme) => ({ color: theme.colors.destructive });

function getNoteText(download: Download, t: TFunction): string {
  if (download.status === "error") {
    return `${download.fileName} · ${download.message ?? t("common.states.downloadFailed")}`;
  }
  if (download.saved) return t("downloads.savedNote", { fileName: download.fileName });
  return `${download.fileName} · ${
    download.savedTo
      ? t("downloads.savedTo", { where: download.savedTo })
      : t("common.states.downloadComplete")
  }`;
}

/**
 * The one download the app is showing, as a thin bar under the screen header: name and percent
 * while it runs, then a short note with what the file can do next. It sits at the same place on
 * every screen, so a download started from a chat stays in view when the owner leaves the chat.
 */
export function DownloadBar() {
  const insets = useSafeAreaInsets();
  const isCompact = useIsCompactFormFactor();
  const download = useDownloadStore((state) =>
    state.activeDownloadId ? state.downloads.get(state.activeDownloadId) : undefined,
  );
  const dismissDownload = useDownloadStore((state) => state.dismissDownload);

  const hasActions = Boolean(download?.saved || download?.revealPath);
  useEffect(() => {
    if (!download || download.status === "downloading") return;
    const timeout = setTimeout(
      () => dismissDownload(download.id),
      hasActions ? ACTION_DISMISS_DELAY : AUTO_DISMISS_DELAY,
    );
    return () => clearTimeout(timeout);
  }, [download, dismissDownload, hasActions]);

  const top = isCompact
    ? insets.top + HEADER_TOP_PADDING_MOBILE + HEADER_INNER_HEIGHT_MOBILE
    : insets.top + HEADER_INNER_HEIGHT + SPACING[2];
  // A phone gets a full-width strip; a wide window a centered box, so it leaves the sidebar alone.
  const containerStyle = useMemo(
    () => [isCompact ? styles.container : styles.containerFloating, { top }],
    [isCompact, top],
  );

  if (!download) return null;

  return (
    <View style={containerStyle} pointerEvents="box-none">
      {download.status === "downloading" ? (
        <DownloadProgressRow download={download} floating={!isCompact} />
      ) : (
        <DownloadNoteRow download={download} floating={!isCompact} onDismiss={dismissDownload} />
      )}
    </View>
  );
}

function DownloadProgressRow({ download, floating }: { download: Download; floating: boolean }) {
  const { t } = useTranslation();
  const percent = download.progress ? Math.round(download.progress.percent * 100) : null;
  const value = useMemo(
    () => (percent === null ? undefined : { min: 0, max: 100, now: percent }),
    [percent],
  );
  return (
    <View
      style={floating ? styles.barFloating : styles.bar}
      testID="download-bar"
      accessibilityRole="progressbar"
      accessibilityLabel={download.fileName}
      accessibilityValue={value}
    >
      <View style={styles.row}>
        <Text style={styles.fileName} numberOfLines={1}>
          {download.fileName}
        </Text>
        <Text style={styles.percent} testID="download-bar-percent">
          {percent === null ? t("common.states.starting") : `${percent}%`}
        </Text>
      </View>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${percent ?? 0}%` }]} />
      </View>
    </View>
  );
}

function DownloadNoteRow({
  download,
  floating,
  onDismiss,
}: {
  download: Download;
  floating: boolean;
  onDismiss: (id: string) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const { id, saved, revealPath, fileName } = download;

  const dismiss = useCallback(() => onDismiss(id), [id, onDismiss]);
  const open = useCallback(() => {
    if (!saved) return;
    onDismiss(id);
    router.navigate(buildSavedFileRoute(saved));
  }, [id, onDismiss, saved]);
  const install = useCallback(async () => {
    if (!saved) return;
    onDismiss(id);
    try {
      const file = await getOfflineFile(saved.serverId, saved.path);
      if (!file) throw new Error(t("downloads.installFailed"));
      await installSavedPackage(file);
    } catch {
      toast.error(t("downloads.installFailed"));
    }
  }, [id, onDismiss, saved, t, toast]);
  const reveal = useCallback(() => {
    if (revealPath) void revealSavedFile(revealPath);
  }, [revealPath]);

  return (
    <View
      style={floating ? styles.barFloating : styles.bar}
      testID="download-note"
      accessibilityRole="alert"
    >
      <View style={styles.row}>
        {download.status === "error" ? (
          <ThemedXCircle size={14} uniProps={errorIcon} />
        ) : (
          <ThemedCheck size={14} uniProps={successIcon} />
        )}
        <Text style={styles.noteText} numberOfLines={1} testID="download-note-text">
          {getNoteText(download, t)}
        </Text>
        {saved ? (
          <Button variant="ghost" size="sm" onPress={open} testID="download-note-open">
            {t("downloads.open")}
          </Button>
        ) : null}
        {saved && canInstallPackage(fileName) ? (
          <Button variant="default" size="sm" onPress={install} testID="download-note-install">
            {t("downloads.install")}
          </Button>
        ) : null}
        {revealPath && canRevealSavedFile() ? (
          <Button variant="ghost" size="sm" onPress={reveal} testID="download-bar-reveal">
            {getIsElectronMac() ? t("downloads.showInFinder") : t("downloads.showInFolder")}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          leftIcon={X}
          onPress={dismiss}
          accessibilityLabel={t("common.actions.dismiss")}
          testID="download-note-dismiss"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    position: "absolute",
    left: 0,
    right: 0,
    zIndex: OVERLAY_Z.toast,
  },
  containerFloating: {
    position: "absolute",
    left: theme.spacing[4],
    right: theme.spacing[4],
    zIndex: OVERLAY_Z.toast,
    alignItems: "center",
  },
  bar: {
    backgroundColor: theme.colors.surface1,
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  barFloating: {
    width: "100%",
    maxWidth: 560,
    overflow: "hidden",
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    ...theme.shadow.md,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 32,
    paddingLeft: theme.spacing[4],
    paddingRight: theme.spacing[2],
  },
  fileName: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  percent: {
    paddingRight: theme.spacing[2],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  noteText: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  track: {
    height: 2,
    backgroundColor: theme.colors.surface2,
  },
  fill: {
    height: "100%",
    backgroundColor: theme.colors.primary,
  },
}));
