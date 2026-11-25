import { releaseAttachmentPreviewUrl, resolveAttachmentPreviewUrl } from "@/attachments/service";
import type { FileContents, FileObservation, FileSession } from "@/file-panels/file/handle";
import { getAppSettings } from "@/hooks/use-settings";
import { i18n } from "@/i18n/i18next";
import {
  getOfflineFile,
  isSameOfflineVersion,
  readOfflineFileBytes,
  saveOfflineFile,
  touchOfflineFile,
  type OfflineFile,
} from "./store";

const MB = 1024 * 1024;

/** A read-only file session over a saved copy, for when the host is offline. */
export function createOfflineFileSession(entry: OfflineFile): FileSession {
  return {
    async observe() {
      return {
        initial: {
          status: "ready",
          size: entry.size,
          modifiedAt: entry.modifiedAt,
          revision: entry.revision,
          kind: entry.kind,
          mimeType: entry.mimeType,
        },
        unsubscribe() {},
      };
    },
    async read() {
      const bytes = await readOfflineFileBytes(entry);
      return { bytes, size: entry.size, modifiedAt: entry.modifiedAt, revision: entry.revision };
    },
    async write() {
      throw new Error(i18n.t("offlineFiles.readOnly"));
    },
    async createUrl() {
      const url = await resolveAttachmentPreviewUrl(entry.attachment);
      return {
        url,
        release() {
          void releaseAttachmentPreviewUrl({ attachment: entry.attachment, url });
        },
      };
    },
  };
}

/**
 * Wraps a live session so every read keeps a copy in the Saved library: a file opened for the
 * first time is saved when it fits the per-file limit, and a saved file is refreshed when it
 * changed. The bytes are already in hand, so this costs no extra download.
 */
export function withSavedCopy(
  session: FileSession,
  input: { serverId: string; path: string },
): FileSession {
  // A panel reads only after the stat names the file's kind; the copy keeps that kind.
  let observed: Pick<OfflineFile, "kind" | "mimeType"> | null = null;
  const remember = (observation: FileObservation) => {
    if (observation.status === "ready") {
      observed = { kind: observation.kind, mimeType: observation.mimeType };
    }
  };
  return {
    ...session,
    async observe(target, onObservation) {
      const subscription = await session.observe(target, (observation) => {
        remember(observation);
        onObservation(observation);
      });
      remember(subscription.initial);
      return subscription;
    },
    async read(target) {
      const contents = await session.read(target);
      void keepCopy(input, contents, observed).catch(() => undefined);
      return contents;
    },
  };
}

async function keepCopy(
  input: { serverId: string; path: string },
  contents: FileContents,
  observed: Pick<OfflineFile, "kind" | "mimeType"> | null,
): Promise<void> {
  const saved = await getOfflineFile(input.serverId, input.path);
  // Opening an unchanged file restarts its retention window.
  if (saved && isSameOfflineVersion(saved, contents)) {
    await touchOfflineFile(input.serverId, input.path);
    return;
  }
  const kind = saved ?? observed;
  const settings = await getAppSettings();
  if (!kind || contents.bytes.byteLength > settings.offlineFilesMaxFileMb * MB) return;
  await saveOfflineFile({
    serverId: input.serverId,
    path: input.path,
    version: { ...contents, kind: kind.kind, mimeType: kind.mimeType },
    bytes: contents.bytes,
    limits: settings,
  });
}
