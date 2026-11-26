import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, rm, rmdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";

/**
 * Where uploads live on the host: `$PASEO_HOME/uploads/<YYYY-MM-DD>/<file name>`.
 *
 * Agents save uploads back into projects weeks later, so the path is short and readable and
 * carries no random id. An upload's id is its path relative to `uploads/` (`2026-11-25/shot.png`).
 * Older uploads sit in `upload_<uuid>/<file name>` folders; those ids and paths keep working.
 * Uploads are never pruned.
 */

const LEGACY_UPLOAD_ID = /^upload_[0-9a-f-]{36}$/i;
const DATED_UPLOAD_ID = /^(\d{4}-\d{2}-\d{2})\/([^/\\]+)$/;

// Most file systems cap a single file name at 255 bytes.
const MAX_FILE_NAME_BYTES = 255;

export interface UploadFile {
  id: string;
  path: string;
}

function uploadsRoot(paseoHome: string): string {
  return join(paseoHome, "uploads");
}

function localDay(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function isSafeFileName(name: string): boolean {
  return name !== "." && name !== "..";
}

/** True for an id this module can resolve. Ids come from clients, so check before touching disk. */
export function isUploadId(id: string): boolean {
  if (LEGACY_UPLOAD_ID.test(id)) return true;
  const dated = DATED_UPLOAD_ID.exec(id);
  return dated !== null && isSafeFileName(dated[2]);
}

/**
 * Creates an empty file for a new upload in today's folder. A name already taken that day
 * becomes `name-2.ext`, `name-3.ext`, and so on; an existing file is never overwritten.
 */
export async function createUploadFile(
  paseoHome: string,
  fileName: string,
  now: Date = new Date(),
): Promise<UploadFile> {
  const day = localDay(now);
  const dir = join(uploadsRoot(paseoHome), day);
  await mkdir(dir, { recursive: true });
  for (let attempt = 1; ; attempt += 1) {
    const name = attempt === 1 ? fileName : withCounter(fileName, attempt);
    try {
      await (await open(join(dir, name), "wx")).close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    return { id: `${day}/${name}`, path: join(dir, name) };
  }
}

/**
 * Creates an upload in its own `upload_<uuid>/` folder. Internal uploads whose folder is
 * deleted as a whole (see file-copies) stay here; they are not files an agent saves back.
 */
export async function createLegacyUploadFile(
  paseoHome: string,
  fileName: string,
): Promise<UploadFile> {
  const id = `upload_${randomUUID()}`;
  const dir = join(uploadsRoot(paseoHome), id);
  await mkdir(dir, { recursive: true });
  await (await open(join(dir, fileName), "wx")).close();
  return { id, path: join(dir, fileName) };
}

/** The file behind an upload id, or null when the id is not one of ours or the file is gone. */
export async function resolveUploadFile(
  paseoHome: string,
  id: string,
): Promise<{ path: string; fileName: string } | null> {
  if (!isUploadId(id)) return null;
  if (LEGACY_UPLOAD_ID.test(id)) {
    const dir = join(uploadsRoot(paseoHome), id);
    const [fileName] = await readdir(dir).catch(() => [] as string[]);
    return fileName ? { path: join(dir, fileName), fileName } : null;
  }
  const fileName = basename(id);
  return { path: join(uploadsRoot(paseoHome), id), fileName };
}

/** Deletes one upload: its own file only, plus its folder when that leaves it empty. */
export async function removeUploadFile(paseoHome: string, id: string): Promise<void> {
  if (!isUploadId(id)) return;
  if (LEGACY_UPLOAD_ID.test(id)) {
    await rm(join(uploadsRoot(paseoHome), id), { recursive: true, force: true });
    return;
  }
  await rm(join(uploadsRoot(paseoHome), id), { force: true });
  // Fails when another upload still shares the day folder, which is the point.
  await rmdir(join(uploadsRoot(paseoHome), id.slice(0, id.indexOf("/")))).catch(() => undefined);
}

// Keeps the client's file name, replacing only what cannot appear in a single
// file name on Linux, macOS, or Windows.
export function sanitizeUploadFileName(value: string): string {
  const name = basename(value)
    .replace(/[\p{Cc}\\/:*?"<>|]/gu, "_")
    .trim();
  return fitFileNameLength(name.length > 0 && isSafeFileName(name) ? name : "upload");
}

function fitFileNameLength(name: string): string {
  if (Buffer.byteLength(name) <= MAX_FILE_NAME_BYTES) return name;
  const extension = extname(name);
  const keptExtension = Buffer.byteLength(extension) < MAX_FILE_NAME_BYTES ? extension : "";
  let stem = "";
  for (const char of name.slice(0, name.length - keptExtension.length)) {
    if (Buffer.byteLength(stem + char + keptExtension) > MAX_FILE_NAME_BYTES) break;
    stem += char;
  }
  return stem + keptExtension;
}

// `shot.png` -> `shot-2.png`, trimming the stem when the counter would pass the name limit.
function withCounter(name: string, counter: number): string {
  const extension = extname(name);
  const suffix = `-${counter}${extension}`;
  let stem = "";
  for (const char of name.slice(0, name.length - extension.length)) {
    if (Buffer.byteLength(stem + char + suffix) > MAX_FILE_NAME_BYTES) break;
    stem += char;
  }
  return stem + suffix;
}
