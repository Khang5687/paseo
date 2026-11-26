import { getDesktopHost } from "@/desktop/host";
import { saveBrowserFile } from "./browser-download";
import type { SaveOutcome, SaveRequest } from "./types";

/**
 * Web and Electron. A browser decides where a download goes, so the "ask" setting does nothing
 * there. The desktop app owns the destination: the native Save dialog, or Downloads › Paseo.
 */
export async function saveFile({
  content,
  fileName,
  mimeType,
  preferences,
}: SaveRequest): Promise<SaveOutcome> {
  if ("uri" in content) {
    throw new Error("A cached file cannot be saved in a browser.");
  }
  const save = getDesktopHost()?.files?.save;
  if ("managedPath" in content) {
    if (!save) {
      throw new Error("A managed file needs the desktop app.");
    }
    // The shell copies the file itself; a big file never crosses the bridge.
    const copied = await save({
      fileName,
      sourcePath: content.managedPath,
      ask: preferences.askWhere,
    });
    return copied.status === "cancelled"
      ? { kind: "cancelled" }
      : { kind: "saved", where: copied.folderLabel, revealPath: copied.path };
  }
  // COMPAT(desktopFileSave): a desktop shell older than the Save dialog has no `files` bridge and
  // gets the browser's download. Added in v0.17.0, remove after 2027-05-26.
  if (!save) {
    saveBrowserFile(toBlob(content, mimeType), fileName);
    return { kind: "handedOff" };
  }
  const bytes =
    content instanceof Uint8Array ? content : new Uint8Array(await content.arrayBuffer());
  const result = await save({ fileName, bytes, ask: preferences.askWhere });
  if (result.status === "cancelled") {
    return { kind: "cancelled" };
  }
  return { kind: "saved", where: result.folderLabel, revealPath: result.path };
}

function toBlob(content: Uint8Array | Blob, mimeType: string | null): Blob {
  if (content instanceof Blob) {
    return content;
  }
  const buffer = new ArrayBuffer(content.byteLength);
  new Uint8Array(buffer).set(content);
  return new Blob([buffer], { type: mimeType ?? "application/octet-stream" });
}
