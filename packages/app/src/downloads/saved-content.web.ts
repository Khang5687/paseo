import { resolveAttachmentPreviewUrl, releaseAttachmentPreviewUrl } from "@/attachments/service";
import { getDesktopHost } from "@/desktop/host";
import type { OfflineFile } from "@/offline-files/store";
import type { DownloadContent } from "./types";

/**
 * Web and Electron. Desktop: the shell copies the Saved file from managed storage itself, so no
 * bytes cross the bridge. A browser gets a Blob; the browser keeps its data in its own storage,
 * not in the page's memory.
 */
export async function readSavedContent(file: OfflineFile): Promise<DownloadContent> {
  if (getDesktopHost()?.files?.save) {
    return { managedPath: file.attachment.storageKey };
  }
  const url = await resolveAttachmentPreviewUrl(file.attachment);
  try {
    return await (await fetch(url)).blob();
  } finally {
    await releaseAttachmentPreviewUrl({ attachment: file.attachment, url });
  }
}
