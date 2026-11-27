import { Directory, File as FSFile, Paths } from "expo-file-system";
import { Platform } from "react-native";
import { i18n } from "@/i18n/i18next";
import { resolveDownloadTargetFile } from "./cache-file";
import { sanitizeDownloadFileName, uniqueFileName } from "./file-names";
import { pickDirectory } from "./folder";
import { shareSavedFile } from "./share-file";
import type { SaveOutcome, SaveRequest } from "./types";

/** The folder inside the app's Documents that the Files app shows on iOS (Info.plist sharing keys). */
const IOS_SAVE_DIRECTORY = "Downloads";

/**
 * iOS and Android. "Ask" opens the system's own destination UI: the share sheet on iOS (it has
 * Save to Files and Save Video), a folder picker on Android. "Don't ask" saves to a place the
 * owner can open without Paseo: the app's folder in the Files app on iOS, a folder picked once
 * on Android.
 */
export async function saveFile(request: SaveRequest): Promise<SaveOutcome> {
  const cached = await toCacheFile(request);
  if (Platform.OS === "ios") {
    return request.preferences.askWhere
      ? shareFile(cached, request)
      : saveToFilesApp(cached, request.fileName);
  }
  return saveToAndroidFolder(cached, request);
}

async function toCacheFile({ content, fileName }: SaveRequest): Promise<FSFile> {
  if (content instanceof Uint8Array) {
    // Resolve and write in one tick so two downloads of the same name cannot pick the same path.
    const file = resolveDownloadTargetFile(fileName);
    file.write(content);
    return file;
  }
  if ("uri" in content) {
    return new FSFile(content.uri);
  }
  throw new Error("A Blob cannot be saved on a phone.");
}

function nameExists(directory: Directory, name: string): boolean {
  return new FSFile(directory, name).exists;
}

async function shareFile(file: FSFile, { fileName, mimeType }: SaveRequest): Promise<SaveOutcome> {
  await shareSavedFile(file.uri, mimeType, fileName);
  return { kind: "handedOff" };
}

async function saveToFilesApp(file: FSFile, fileName: string): Promise<SaveOutcome> {
  const directory = new Directory(Paths.document, IOS_SAVE_DIRECTORY);
  directory.create({ intermediates: true, idempotent: true });
  const name = uniqueFileName(fileName, (candidate) => nameExists(directory, candidate));
  await file.move(new FSFile(directory, name));
  return { kind: "saved", where: i18n.t("downloads.iosFolder"), revealPath: null };
}

async function saveToAndroidFolder(file: FSFile, request: SaveRequest): Promise<SaveOutcome> {
  const { preferences } = request;
  if (!preferences.askWhere && preferences.folderUri) {
    const stored = new Directory(preferences.folderUri);
    if (directoryIsUsable(stored)) {
      return writeIntoFolder(stored, file, request);
    }
    // The folder was deleted or its permission was revoked: choose again below.
  }
  const picked = await pickDirectory();
  if (!picked) {
    return { kind: "cancelled" };
  }
  if (!preferences.askWhere) {
    preferences.onFolderPicked?.(picked.uri);
  }
  return writeIntoFolder(picked, file, request);
}

function directoryIsUsable(directory: Directory): boolean {
  try {
    return directory.exists;
  } catch {
    return false;
  }
}

async function writeIntoFolder(
  directory: Directory,
  file: FSFile,
  { fileName, mimeType }: SaveRequest,
): Promise<SaveOutcome> {
  // A SAF folder renames the new document itself when the name is taken.
  const target = directory.createFile(
    sanitizeDownloadFileName(fileName),
    mimeType ?? "application/octet-stream",
  );
  await file.copy(target, { overwrite: true });
  file.delete();
  return { kind: "saved", where: directory.name, revealPath: null };
}
