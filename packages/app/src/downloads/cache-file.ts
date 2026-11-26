import { File as FSFile, Paths } from "expo-file-system";
import { uniqueFileName } from "./file-names";

/** A free path in the app cache for a download, named like the original file. */
export function resolveDownloadTargetFile(fileName: string): FSFile {
  const directory = Paths.cache ?? Paths.document;
  if (!directory) {
    throw new Error("No download directory available.");
  }
  return new FSFile(
    directory,
    uniqueFileName(fileName, (name) => new FSFile(directory, name).exists),
  );
}
