import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export type SaveFileResult =
  | { status: "saved"; path: string; folderLabel: string }
  | { status: "cancelled" };

export interface SaveFileInput {
  fileName: string;
  bytes: Uint8Array;
  ask: boolean;
}

export interface FileSaveDeps {
  downloadsDir: string;
  /** Shows the native Save dialog; resolves the chosen path or `null` when cancelled. */
  chooseSavePath: (defaultPath: string) => Promise<string | null>;
}

const DEFAULT_FOLDER_NAME = "Paseo";
const DEFAULT_FOLDER_LABEL = `Downloads \u203a ${DEFAULT_FOLDER_NAME}`;

/** A file name with no directory part, so a renderer cannot write outside the folder it asks for. */
export function sanitizeFileName(value: string): string {
  const base = value.split(/[\\/]/).pop()?.trim() ?? "";
  const cleaned = base.replace(/[:*?"<>|]+/g, "_");
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "download";
}

/** Writes `report.pdf`, then `report (1).pdf` while the name is taken. Never overwrites. */
export async function writeUniqueFile(
  directory: string,
  fileName: string,
  bytes: Uint8Array,
): Promise<string> {
  const extension = path.extname(fileName);
  const stem = extension ? fileName.slice(0, -extension.length) : fileName;
  for (let suffix = 0; ; suffix += 1) {
    const candidate = path.join(
      directory,
      suffix === 0 ? fileName : `${stem} (${suffix})${extension}`,
    );
    try {
      await writeFile(candidate, bytes, { flag: "wx" });
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
  }
}

export async function saveFile(input: unknown, deps: FileSaveDeps): Promise<SaveFileResult> {
  if (
    typeof input !== "object" ||
    input === null ||
    typeof (input as SaveFileInput).fileName !== "string" ||
    !((input as SaveFileInput).bytes instanceof Uint8Array)
  ) {
    throw new Error("Invalid save request.");
  }
  const { fileName: rawName, bytes, ask } = input as SaveFileInput;
  const fileName = sanitizeFileName(rawName);

  if (ask === true) {
    const chosen = await deps.chooseSavePath(path.join(deps.downloadsDir, fileName));
    if (chosen === null) {
      return { status: "cancelled" };
    }
    // The dialog already asked about replacing a file that exists.
    await writeFile(chosen, bytes);
    return { status: "saved", path: chosen, folderLabel: path.basename(path.dirname(chosen)) };
  }

  const directory = path.join(deps.downloadsDir, DEFAULT_FOLDER_NAME);
  await mkdir(directory, { recursive: true });
  const written = await writeUniqueFile(directory, fileName, bytes);
  return { status: "saved", path: written, folderLabel: DEFAULT_FOLDER_LABEL };
}
