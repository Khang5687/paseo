import { useCallback, useEffect, useRef } from "react";
import { Text } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { useToast } from "@/contexts/toast-context";
import { addSavedFile } from "@/offline-files/saver";
import { getHostRuntimeStore, useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useDownloadStore, withTransferProgress } from "@/stores/download-store";
import { fileNameOf } from "./model";
import { receiveSentFile, type ReceiveSentFileDeps } from "./receive-sent-file";
import { SendToSheet } from "./send-to-sheet";
import { useSendToStore, type SentFileNotice } from "./store";

const HOST_WAIT_MS = 10_000;
const HOST_POLL_MS = 250;

/** A note can arrive before the app has reconnected, so give the host a few seconds. */
async function waitForHost(serverId: string): Promise<boolean> {
  const deadline = Date.now() + HOST_WAIT_MS;
  for (;;) {
    const online = getHostRuntimeStore().getSnapshot(serverId)?.connectionStatus === "online";
    if (online && useSessionStore.getState().sessions[serverId]?.client) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, HOST_POLL_MS));
  }
}

const deps: ReceiveSentFileDeps = {
  waitForHost,
  save: ({ serverId, path }) =>
    withTransferProgress(
      { serverId, scopeId: serverId, fileName: fileNameOf(path) },
      (onProgress) => addSavedFile({ serverId, path, onProgress }),
    ),
  noteSaved: ({ serverId, path }) =>
    useDownloadStore.getState().noteSaved({ serverId, path, fileName: fileNameOf(path) }),
};

/**
 * Everything the app does around "Send to", mounted once at the root: the device picker, the
 * handling of a tap on "<file> is ready", and that note for the foreground app.
 */
export function SendToHost() {
  const { t } = useTranslation();
  const toast = useToast();
  const hosts = useHosts();
  const tapped = useSendToStore((state) => state.tapped);
  const notice = useSendToStore((state) => state.notice);
  // The download bar and the saved note take the toast's place, so a tap closes the toast.
  const dismissNoticeRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!tapped) return;
    useSendToStore.getState().clearTap();
    dismissNoticeRef.current();
    const host = hosts.find((entry) => entry.serverId === tapped.serverId)?.label;
    void receiveSentFile(tapped, deps).then((outcome) => {
      if (outcome.status === "hostOffline") {
        toast.error(t("sendTo.hostOffline", { host: host ?? tapped.serverId }));
      } else if (outcome.status === "tooLarge") {
        toast.error(t("offlineFiles.tooLarge", { size: outcome.maxFileMb }));
      } else if (outcome.status === "failed") {
        toast.error(outcome.error);
      }
      return outcome;
    });
  }, [hosts, t, tapped, toast]);

  useEffect(() => {
    if (!notice) return;
    useSendToStore.getState().clearNotice();
    dismissNoticeRef.current = toast.show(<SentFileNoticeContent notice={notice} />, {
      variant: "info",
      durationMs: 8000,
    });
  }, [notice, toast]);

  return <SendToSheet />;
}

function SentFileNoticeContent({ notice }: { notice: SentFileNotice }) {
  const { t } = useTranslation();
  const receive = useCallback(() => useSendToStore.getState().tap(notice), [notice]);
  return (
    <Text
      style={styles.notice}
      onPress={receive}
      accessibilityRole="button"
      testID="send-to-notice"
    >
      {t("sendTo.noticeTap", { title: notice.title || fileNameOf(notice.path) })}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  notice: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
}));
