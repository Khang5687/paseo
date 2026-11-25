import { promises as fs } from "node:fs";
import path from "node:path";
import type pino from "pino";

/**
 * The file name every copy upload carries, so the copy flow can tell its own folders in
 * `$PASEO_HOME/uploads/` from chat attachments. `files.copies.put` names the real path.
 */
export const FILE_COPY_UPLOAD_NAME = ".paseo-file-copy";

export const LEFTOVER_COPY_UPLOAD_AGE_MS = 24 * 60 * 60 * 1000;

const UPLOAD_ID = /^upload_[0-9a-f-]{36}$/;

export function copyUploadDir(paseoHome: string, uploadId: string): string {
  if (!UPLOAD_ID.test(uploadId)) throw new Error("Unknown upload");
  return path.join(paseoHome, "uploads", uploadId);
}

/**
 * Deletes copy uploads whose `files.copies.put` never came, once they are a day old. A put moves
 * the file into the copy store and deletes its folder, so no copy refers to one left behind.
 * Folders holding anything else are other features' uploads and stay.
 */
export async function removeLeftoverCopyUploads(
  paseoHome: string,
  logger: pino.Logger,
  now = Date.now(),
): Promise<number> {
  const root = path.join(paseoHome, "uploads");
  const ids = await fs.readdir(root).catch(() => [] as string[]);
  let removed = 0;
  for (const id of ids) {
    if (!UPLOAD_ID.test(id)) continue;
    const dir = path.join(root, id);
    const names = await fs.readdir(dir).catch(() => null);
    if (names?.length !== 1 || names[0] !== FILE_COPY_UPLOAD_NAME) continue;
    const stats = await fs.stat(path.join(dir, FILE_COPY_UPLOAD_NAME)).catch(() => null);
    if (!stats || now - stats.mtimeMs < LEFTOVER_COPY_UPLOAD_AGE_MS) continue;
    await fs.rm(dir, { recursive: true, force: true });
    removed += 1;
  }
  if (removed > 0) logger.info({ removed }, "Removed leftover file copy uploads");
  return removed;
}
