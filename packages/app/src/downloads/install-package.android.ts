import { File as FSFile } from "expo-file-system";
import { startActivityAsync } from "expo-intent-launcher";
import { pathToFileUri } from "@/attachments/utils";
import { canInstallPackages } from "@/constants/build-profile";
import type { OfflineFile } from "@/offline-files/store";

const APK_MIME_TYPE = "application/vnd.android.package-archive";
// android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION: the installer reads the file through
// expo-file-system's FileProvider, which only answers apps granted the URI.
const FLAG_GRANT_READ_URI_PERMISSION = 1;

/**
 * Only builds with `REQUEST_INSTALL_PACKAGES` (the fork and debug variants, see app.config.js)
 * can start Android's installer. Without it the installer refuses the file.
 */
export function canInstallPackage(fileName: string): boolean {
  return canInstallPackages && /\.apk$/i.test(fileName);
}

/**
 * Opens Android's installer on the Saved copy. Android asks once to allow installs from Paseo,
 * then "Do you want to update this app?". The copy lives in the app cache, which the FileProvider
 * shares, so nothing is copied out first.
 */
export async function installSavedPackage(file: OfflineFile): Promise<void> {
  const { contentUri } = new FSFile(pathToFileUri(file.attachment.storageKey));
  await startActivityAsync("android.intent.action.VIEW", {
    data: contentUri,
    type: APK_MIME_TYPE,
    flags: FLAG_GRANT_READ_URI_PERMISSION,
  });
}
