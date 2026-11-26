/** How the owner wants downloads delivered; read from settings when a download starts. */
export interface SavePreferences {
  /** Ask where each file goes (the setting is on by default). Off saves to the device's default place. */
  askWhere: boolean;
  /** Android: the folder picked once for "off" (a SAF tree URI); `null` until the first save. */
  folderUri: string | null;
  /** Android: remember the folder picked on the first save with "off". */
  onFolderPicked?: (folderUri: string) => void;
}

/**
 * The downloaded file. A small file may be bytes. The HTTP route hands over a Blob on web and a
 * file already in the app cache on native, and a file read over the session socket arrives as a
 * Saved copy: a cache copy on native, a Blob in a browser, a path in managed storage on desktop.
 * So a big file never passes through JS memory. A platform rejects the kind it never produces.
 */
export type DownloadContent = Uint8Array | Blob | { uri: string } | { managedPath: string };

export interface SaveRequest {
  content: DownloadContent;
  fileName: string;
  mimeType: string | null;
  preferences: SavePreferences;
}

export type SaveOutcome =
  /** The file is in a folder. `where` names it for the toast; `revealPath` lets desktop show it. */
  | { kind: "saved"; where: string; revealPath: string | null }
  /** The share sheet or the browser took over; Paseo cannot tell where the file went. */
  | { kind: "handedOff" }
  | { kind: "cancelled" };
