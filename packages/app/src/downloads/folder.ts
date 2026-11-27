import { Directory } from "expo-file-system";

const PICKER_CANCELLED_CODE = "ERR_PICKER_CANCELLED";

/** The folder picker the owner chose with, or `null` when they backed out of it. */
export async function pickDirectory(): Promise<Directory | null> {
  try {
    return await Directory.pickDirectoryAsync();
  } catch (error) {
    if (isPickerCancelled(error)) {
      return null;
    }
    throw error;
  }
}

function isPickerCancelled(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === PICKER_CANCELLED_CODE
  );
}

/** A short name for a folder URI, for the settings row. */
export function describeFolder(folderUri: string | null): string | null {
  if (!folderUri) {
    return null;
  }
  try {
    return new Directory(folderUri).name;
  } catch {
    return null;
  }
}
