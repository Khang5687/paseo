import { constants, copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export type SaveFileResult =
  | { status: "saved"; path: string; folderLabel: string }
  | { status: "cancelled" };

export interface SaveFileInput {
  fileName: string;
  /** The file's bytes. A big file gives `sourcePath` instead, so it never crosses the bridge. */
  bytes?: Uint8Array;
  /** A file in Paseo's managed attachment storage to copy. */
  sourcePath?: string;
  ask: boolean;
}

export interface FileSaveDeps {
  downloadsDir: string;
  /** Shows the native Save dialog; resolves the chosen path or `null` when cancelled. */
  chooseSavePath: (defaultPath: string) => Promise<string | null>;
  /** Returns `sourcePath` when it lies in managed attachment storage, and throws otherwise. */
  resolveSourcePath: (sourcePath: string) => string;
}

const DEFAULT_FOLDER_NAME = "Paseo";
const DEFAULT_FOLDER_LABEL = `Downloads \u203a ${DEFAULT_FOLDER_NAME}`;

type SaveSource = { bytes: Uint8Array } | { copyFrom: string };

/** A file name with no directory part, so a renderer cannot write outside the folder it asks for. */
export function sanitizeFileName(value: string): string {
  const base = value.split(/[\\/]/).pop()?.trim() ?? "";
  const cleaned = base.replace(/[:*?"<>|]+/g, "_");
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "download";
}

/** Writes the source to `target`; `exclusive` fails with EEXIST instead of overwriting. */
async function writeSource(target: string, source: SaveSource, exclusive: boolean): Promise<void> {
  if ("bytes" in source) {
    await writeFile(target, source.bytes, exclusive ? { flag: "wx" } : undefined);
    return;
  }
  await copyFile(source.copyFrom, target, exclusive ? constants.COPYFILE_EXCL : 0);
}

/** Writes `report.pdf`, then `report (1).pdf` while the name is taken. Never overwrites. */
export async function writeUniqueFile(
  directory: string,
  fileName: string,
  source: SaveSource,
): Promise<string> {
  const extension = path.extname(fileName);
  const stem = extension ? fileName.slice(0, -extension.length) : fileName;
  for (let suffix = 0; ; suffix += 1) {
    const candidate = path.join(
      directory,
      suffix === 0 ? fileName : `${stem} (${suffix})${extension}`,
    );
    try {
      await writeSource(candidate, source, true);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
  }
}

function readSource(input: SaveFileInput, deps: FileSaveDeps): SaveSource {
  if (input.bytes instanceof Uint8Array) {
    return { bytes: input.bytes };
  }
  if (typeof input.sourcePath === "string") {
    return { copyFrom: deps.resolveSourcePath(input.sourcePath) };
  }
  throw new Error("Invalid save request.");
}

export async function saveFile(input: unknown, deps: FileSaveDeps): Promise<SaveFileResult> {
  if (
    typeof input !== "object" ||
    input === null ||
    typeof (input as SaveFileInput).fileName !== "string"
  ) {
    throw new Error("Invalid save request.");
  }
  const request = input as SaveFileInput;
  const source = readSource(request, deps);
  const fileName = sanitizeFileName(request.fileName);

  if (request.ask === true) {
    const chosen = await deps.chooseSavePath(path.join(deps.downloadsDir, fileName));
    if (chosen === null) {
      return { status: "cancelled" };
    }
    // The dialog already asked about replacing a file that exists.
    await writeSource(chosen, source, false);
    return { status: "saved", path: chosen, folderLabel: path.basename(path.dirname(chosen)) };
  }

  const directory = path.join(deps.downloadsDir, DEFAULT_FOLDER_NAME);
  await mkdir(directory, { recursive: true });
  const written = await writeUniqueFile(directory, fileName, source);
  return { status: "saved", path: written, folderLabel: DEFAULT_FOLDER_LABEL };
}
