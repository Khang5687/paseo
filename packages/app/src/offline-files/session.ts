import { releaseAttachmentPreviewUrl, resolveAttachmentPreviewUrl } from "@/attachments/service";
import type { FileContents, FileSession } from "@/file-panels/file/handle";
import { getAppSettings } from "@/hooks/use-settings";
import { i18n } from "@/i18n/i18next";
import {
  getOfflineFile,
  isSameOfflineVersion,
  readOfflineFileBytes,
  saveOfflineFile,
  type OfflineFile,
} from "./store";

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
 * Wraps a live session so every read of a saved file refreshes its copy when the file changed.
 * The bytes are already in hand, so a refresh costs no extra download.
 */
export function withOfflineRefresh(
  session: FileSession,
  input: { serverId: string; path: string },
): FileSession {
  return {
    ...session,
    async read(target) {
      const contents = await session.read(target);
      void refreshSavedCopy(input, contents).catch(() => undefined);
      return contents;
    },
  };
}

async function refreshSavedCopy(
  input: { serverId: string; path: string },
  contents: FileContents,
): Promise<void> {
  const saved = await getOfflineFile(input.serverId, input.path);
  if (!saved || isSameOfflineVersion(saved, contents)) return;
  await saveOfflineFile({
    serverId: input.serverId,
    path: input.path,
    version: { ...contents, kind: saved.kind, mimeType: saved.mimeType },
    bytes: contents.bytes,
    limits: await getAppSettings(),
  });
}
