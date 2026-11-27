import type { Directory } from "expo-file-system";

// Browsers and Electron have no folder to remember: the browser or the Save dialog decides.
export async function pickDirectory(): Promise<Directory | null> {
  return null;
}

export function describeFolder(_folderUri: string | null): string | null {
  return null;
}
