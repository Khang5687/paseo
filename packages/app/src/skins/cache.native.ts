import { Directory, File, Paths } from "expo-file-system";
import { ImageManipulator, SaveFormat, type ImageRef } from "expo-image-manipulator";
import { z } from "zod";
import {
  createSkinCache,
  skinMetadataSchema,
  type SkinCacheBackend,
  type SkinOriginal,
} from "./cache-core";
import {
  assertSkinImageByteLength,
  assertSkinImageDimensions,
  base64DecodedLength,
  encodeSkinIdForPath,
  fitLongSide,
  inspectSkinImage,
  SKIN_DISPLAY_MAX_SIDE,
  SKIN_SMALL_MAX_SIDE,
} from "./image-limits";
import type { SkinImageUris, SkinMetadata } from "./types";

export type { SkinOriginal } from "./cache-core";

const ROOT_DIRECTORY_NAME = "skins";
const RECORD_FILE_NAME = "skin.json";
const ENCODE_QUALITY = 0.86;
const SAFE_FILE_NAME = /^[A-Za-z0-9._-]+$/;
const DATA_URI_PATTERN = /^data:[^;,]*(?:;[^;,]*)*;base64,/i;

const recordSchema = z.strictObject({
  meta: skinMetadataSchema,
  display: z.string().regex(SAFE_FILE_NAME),
  small: z.string().regex(SAFE_FILE_NAME),
});

type SkinRecord = z.infer<typeof recordSchema>;

function uniqueToken(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function rootDirectory(): Directory {
  return new Directory(Paths.document, ROOT_DIRECTORY_NAME);
}

function entryDirectory(id: string): Directory {
  return new Directory(rootDirectory(), encodeSkinIdForPath(id));
}

async function readRecord(directory: Directory): Promise<SkinRecord | null> {
  const file = new File(directory, RECORD_FILE_NAME);
  if (!file.exists) return null;
  try {
    const result = recordSchema.safeParse(JSON.parse(await file.text()));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** Writes next to the target, then swaps it in so a crash never leaves a half-written record. */
function replaceFile(target: File, content: string): void {
  const staging = new File(target.parentDirectory, `${target.name}.${uniqueToken()}.tmp`);
  staging.create({ overwrite: true });
  staging.write(content);
  if (target.exists) target.delete();
  staging.move(target);
}

function writeRecord(directory: Directory, record: SkinRecord): void {
  replaceFile(new File(directory, RECORD_FILE_NAME), JSON.stringify(record));
}

// ── original → local file ─────────────────────────────────────────────────────

interface ImportSource {
  file: File;
  dispose(): void;
}

function createImportTempFile(): File {
  const file = new File(Paths.cache, `skin-import-${uniqueToken()}.bin`);
  file.create({ overwrite: true });
  return file;
}

function writeBase64Source(base64: string): ImportSource {
  assertSkinImageByteLength(base64DecodedLength(base64));
  const file = createImportTempFile();
  file.write(base64, { encoding: "base64" });
  return { file, dispose: () => file.delete() };
}

async function resolveImportSource(original: SkinOriginal): Promise<ImportSource> {
  if (original.kind === "base64") return writeBase64Source(original.base64);
  const { uri } = original;
  const dataUri = DATA_URI_PATTERN.exec(uri);
  if (dataUri) return writeBase64Source(uri.slice(dataUri[0].length));
  if (/^https?:\/\//i.test(uri)) {
    const file = createImportTempFile();
    const dispose = () => file.delete();
    try {
      await File.downloadFileAsync(uri, file, { idempotent: true });
      return { file, dispose };
    } catch (error) {
      dispose();
      throw error;
    }
  }
  return { file: new File(uri), dispose: () => undefined };
}

// ── rendering ─────────────────────────────────────────────────────────────────

async function renderVariant(
  base: ImageRef,
  maxSide: number,
  destination: File,
): Promise<ImageRef> {
  const size = fitLongSide(base.width, base.height, maxSide);
  let rendered = base;
  if (size.width !== base.width || size.height !== base.height) {
    const context = ImageManipulator.manipulate(base);
    rendered = await context
      .resize(base.width >= base.height ? { width: size.width } : { height: size.height })
      .renderAsync();
  }
  const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: ENCODE_QUALITY });
  new File(saved.uri).move(destination);
  return rendered;
}

async function writeSkin(meta: SkinMetadata, original: SkinOriginal): Promise<SkinMetadata> {
  const source = await resolveImportSource(original);
  let base: ImageRef | null = null;
  try {
    assertSkinImageByteLength(source.file.size);
    inspectSkinImage(await source.file.bytes());

    base = await ImageManipulator.manipulate(source.file.uri).renderAsync();
    assertSkinImageDimensions(base.width, base.height);

    const directory = entryDirectory(meta.id);
    directory.create({ intermediates: true, idempotent: true });
    const previous = await readRecord(directory);
    const token = uniqueToken();
    const displayName = `display-${token}.jpg`;
    const smallName = `small-${token}.jpg`;

    const display = await renderVariant(
      base,
      SKIN_DISPLAY_MAX_SIDE,
      new File(directory, displayName),
    );
    try {
      const small = await renderVariant(
        display,
        SKIN_SMALL_MAX_SIDE,
        new File(directory, smallName),
      );
      if (small !== display) small.release();
    } finally {
      if (display !== base) display.release();
    }

    writeRecord(directory, { meta, display: displayName, small: smallName });
    if (previous) {
      for (const stale of [previous.display, previous.small]) {
        const file = new File(directory, stale);
        if (file.exists) file.delete();
      }
    }
    return meta;
  } finally {
    base?.release();
    source.dispose();
  }
}

const backend: SkinCacheBackend = {
  async list() {
    const root = rootDirectory();
    if (!root.exists) return [];
    const records = await Promise.all(
      root
        .list()
        .filter((entry): entry is Directory => entry instanceof Directory)
        .map(readRecord),
    );
    return records.flatMap((record) => (record ? [record.meta] : []));
  },
  async readMetadata(id) {
    return (await readRecord(entryDirectory(id)))?.meta ?? null;
  },
  async readImages(id): Promise<SkinImageUris | null> {
    const directory = entryDirectory(id);
    const record = await readRecord(directory);
    if (!record) return null;
    const display = new File(directory, record.display);
    const small = new File(directory, record.small);
    if (!display.exists || !small.exists) return null;
    return { display: display.uri, small: small.uri };
  },
  write: writeSkin,
  async writeMetadata(meta) {
    const directory = entryDirectory(meta.id);
    const record = await readRecord(directory);
    if (!record) throw new Error(`Skin ${meta.id} is not cached on this device`);
    writeRecord(directory, { ...record, meta });
  },
  async remove(id) {
    const directory = entryDirectory(id);
    if (directory.exists) directory.delete();
  },
};

export const {
  listCachedSkins,
  readCachedSkinImages,
  writeCachedSkin,
  deleteCachedSkin,
  updateCachedSkinMetadata,
  useCachedSkins,
} = createSkinCache(backend);
