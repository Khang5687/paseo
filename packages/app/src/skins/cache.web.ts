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
  fitLongSide,
  inspectSkinImage,
  SKIN_DISPLAY_MAX_SIDE,
  SKIN_SMALL_MAX_SIDE,
} from "./image-limits";
import { measureLuminance } from "./luminance";
import type { SkinImageUris, SkinLuminance, SkinMetadata } from "./types";

export type { SkinOriginal } from "./cache-core";

const DATABASE_NAME = "paseo-skin-cache";
const METADATA_STORE = "metadata";
const IMAGES_STORE = "images";
const ENCODE_QUALITY = 0.86;
const LUMINANCE_SAMPLE_WIDTH = 64;

interface StoredImages {
  version: string;
  display: Blob;
  small: Blob;
}

type Surface = OffscreenCanvas | HTMLCanvasElement;
type Context2d = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

let databasePromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  databasePromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.addEventListener("upgradeneeded", () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(METADATA_STORE)) {
        database.createObjectStore(METADATA_STORE);
      }
      if (!database.objectStoreNames.contains(IMAGES_STORE)) {
        database.createObjectStore(IMAGES_STORE);
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("Failed to open the skin cache")),
    );
  }).catch((error: unknown) => {
    databasePromise = null;
    throw error;
  });
  return databasePromise;
}

async function readAll<T>(storeName: string): Promise<T[]> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction(storeName, "readonly").objectStore(storeName).getAll();
    request.addEventListener("success", () => resolve(request.result as T[]));
    request.addEventListener("error", () => reject(request.error));
  });
}

async function readOne<T>(storeName: string, id: string): Promise<T | null> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction(storeName, "readonly").objectStore(storeName).get(id);
    request.addEventListener("success", () => resolve((request.result as T | undefined) ?? null));
    request.addEventListener("error", () => reject(request.error));
  });
}

async function transact(
  storeNames: string[],
  run: (transaction: IDBTransaction) => void,
): Promise<void> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeNames, "readwrite");
    run(transaction);
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("error", () => reject(transaction.error));
    transaction.addEventListener("abort", () =>
      reject(transaction.error ?? new Error("Skin cache transaction aborted")),
    );
  });
}

function parseStoredMetadata(value: unknown): SkinMetadata | null {
  const result = skinMetadataSchema.safeParse(value);
  return result.success ? result.data : null;
}

// ── blob: URL memo ────────────────────────────────────────────────────────────
// One set of object URLs per cached skin so every consumer shares the same decoded image.

const imageUriMemo = new Map<string, Promise<SkinImageUris | null>>();

async function revokeImageUris(id: string): Promise<void> {
  const memoized = imageUriMemo.get(id);
  if (!memoized) return;
  imageUriMemo.delete(id);
  const uris = await memoized.catch(() => null);
  if (!uris) return;
  URL.revokeObjectURL(uris.display);
  URL.revokeObjectURL(uris.small);
}

async function loadImageUris(id: string): Promise<SkinImageUris | null> {
  const stored = await readOne<StoredImages>(IMAGES_STORE, id);
  if (!stored) return null;
  return {
    display: URL.createObjectURL(stored.display),
    small: URL.createObjectURL(stored.small),
  };
}

function readImages(id: string): Promise<SkinImageUris | null> {
  let memoized = imageUriMemo.get(id);
  if (!memoized) {
    memoized = loadImageUris(id);
    imageUriMemo.set(id, memoized);
    const loading = memoized;
    // Drop failed or empty lookups so a later write can be read again.
    void loading.then(
      (uris) => {
        if (!uris && imageUriMemo.get(id) === loading) imageUriMemo.delete(id);
        return undefined;
      },
      () => {
        if (imageUriMemo.get(id) === loading) imageUriMemo.delete(id);
      },
    );
  }
  return memoized;
}

// ── decoding and encoding ─────────────────────────────────────────────────────

function decodeBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function readBlobBytes(blob: Blob): Promise<Uint8Array<ArrayBuffer>> {
  assertSkinImageByteLength(blob.size);
  return new Uint8Array(await blob.arrayBuffer());
}

async function loadOriginalBytes(original: SkinOriginal): Promise<Uint8Array<ArrayBuffer>> {
  if (original.kind === "base64") {
    assertSkinImageByteLength(base64DecodedLength(original.base64));
    return decodeBase64(original.base64);
  }
  const response = await fetch(original.uri);
  if (!response.ok) throw new Error(`Could not read the image (HTTP ${response.status})`);
  return readBlobBytes(await response.blob());
}

function createSurface(width: number, height: number): Surface {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function getContext(surface: Surface): Context2d {
  const context = surface.getContext("2d") as Context2d | null;
  if (!context) throw new Error("Canvas 2D is unavailable");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  return context;
}

function encodeSurface(surface: Surface, type: string): Promise<Blob> {
  if ("convertToBlob" in surface) {
    return surface.convertToBlob({ type, quality: ENCODE_QUALITY });
  }
  return new Promise((resolve, reject) => {
    surface.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Could not encode the image"));
      },
      type,
      ENCODE_QUALITY,
    );
  });
}

let webpEncodable: boolean | null = null;

async function encodeSkinVariant(
  bitmap: ImageBitmap,
  maxSide: number,
): Promise<{ blob: Blob; surface: Surface }> {
  const size = fitLongSide(bitmap.width, bitmap.height, maxSide);
  const surface = createSurface(size.width, size.height);
  const context = getContext(surface);
  context.drawImage(bitmap, 0, 0, size.width, size.height);

  if (webpEncodable !== false) {
    const webp = await encodeSurface(surface, "image/webp");
    webpEncodable = webp.type === "image/webp";
    if (webpEncodable) return { blob: webp, surface };
  }
  // JPEG has no alpha channel: flatten transparent regions onto black.
  context.globalCompositeOperation = "destination-over";
  context.fillStyle = "#000";
  context.fillRect(0, 0, size.width, size.height);
  return { blob: await encodeSurface(surface, "image/jpeg"), surface };
}

function measureSurfaceLuminance(source: Surface): SkinLuminance | null {
  const scale = Math.min(1, LUMINANCE_SAMPLE_WIDTH / source.width);
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const sample = createSurface(width, height);
  const context = getContext(sample);
  context.drawImage(source, 0, 0, width, height);
  return measureLuminance(context.getImageData(0, 0, width, height).data);
}

async function writeSkin(meta: SkinMetadata, original: SkinOriginal): Promise<SkinMetadata> {
  const bytes = await loadOriginalBytes(original);
  const info = inspectSkinImage(bytes);
  const bitmap = await createImageBitmap(new Blob([bytes], { type: `image/${info.format}` }));
  try {
    assertSkinImageDimensions(bitmap.width, bitmap.height);
    const display = await encodeSkinVariant(bitmap, SKIN_DISPLAY_MAX_SIDE);
    const small = await encodeSkinVariant(bitmap, SKIN_SMALL_MAX_SIDE);
    const stored: SkinMetadata = {
      ...meta,
      luminance: meta.luminance ?? measureSurfaceLuminance(small.surface),
    };
    const images: StoredImages = {
      version: meta.version,
      display: display.blob,
      small: small.blob,
    };
    await revokeImageUris(meta.id);
    await transact([METADATA_STORE, IMAGES_STORE], (transaction) => {
      transaction.objectStore(IMAGES_STORE).put(images, meta.id);
      transaction.objectStore(METADATA_STORE).put(stored, meta.id);
    });
    return stored;
  } finally {
    bitmap.close();
  }
}

const backend: SkinCacheBackend = {
  async list() {
    const rows = await readAll<unknown>(METADATA_STORE);
    return rows.flatMap((row) => {
      const meta = parseStoredMetadata(row);
      return meta ? [meta] : [];
    });
  },
  async readMetadata(id) {
    return parseStoredMetadata(await readOne<unknown>(METADATA_STORE, id));
  },
  readImages,
  write: writeSkin,
  async writeMetadata(meta) {
    await transact([METADATA_STORE], (transaction) => {
      transaction.objectStore(METADATA_STORE).put(meta, meta.id);
    });
  },
  async remove(id) {
    await revokeImageUris(id);
    await transact([METADATA_STORE, IMAGES_STORE], (transaction) => {
      transaction.objectStore(METADATA_STORE).delete(id);
      transaction.objectStore(IMAGES_STORE).delete(id);
    });
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
