import { getDesktopHost } from "@/desktop/host";

/** Desktop only: opens the file manager on a file the app saved. */
export function canRevealSavedFile(): boolean {
  return typeof getDesktopHost()?.files?.reveal === "function";
}

export async function revealSavedFile(path: string): Promise<void> {
  await getDesktopHost()?.files?.reveal?.(path);
}
