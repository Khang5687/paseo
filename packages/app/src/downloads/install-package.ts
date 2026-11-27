import type { OfflineFile } from "@/offline-files/store";

/**
 * Whether this build can hand a saved file to the system's package installer. Only Android
 * builds that declare `REQUEST_INSTALL_PACKAGES` can (see `install-package.android.ts`).
 */
export function canInstallPackage(_fileName: string): boolean {
  return false;
}

export async function installSavedPackage(_file: OfflineFile): Promise<void> {
  throw new Error("Installing packages is not supported on this platform.");
}
