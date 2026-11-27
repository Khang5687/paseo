import { File as FSFile } from "expo-file-system";
import { pathToFileUri } from "@/attachments/utils";
import type { OfflineFile } from "@/offline-files/store";
import { resolveDownloadTargetFile } from "./cache-file";
import type { DownloadContent } from "./types";

/**
 * Phones. Hands a Saved file to the save step as a copy in the app cache, because the save step
 * moves the file it is given and the Saved copy has to stay. The copy runs in the native layer,
 * so the file never passes through JS memory.
 */
export async function readSavedContent(
  file: OfflineFile,
  fileName: string,
): Promise<DownloadContent> {
  const target = resolveDownloadTargetFile(fileName);
  await new FSFile(pathToFileUri(file.attachment.storageKey)).copy(target);
  return { uri: target.uri };
}
