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
  if (!(content instanceof Uint8Array) && !(content instanceof Blob)) {
    throw new Error("A cached file cannot be saved in a browser.");
  }
  const save = getDesktopHost()?.files?.save;
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
