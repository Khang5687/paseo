import {
  type AttachmentStore,
  type AttachmentMetadata,
  type AttachmentWriter,
  type OpenAttachmentWriterInput,
  type SaveAttachmentInput,
} from "@/attachments/types";
import {
  blobToBase64,
  generateAttachmentId,
  normalizeMimeType,
  parseDataUrl,
} from "@/attachments/utils";

interface StoredBlobRecord {
  id: string;
  /** A whole file in one record. Absent when the bytes live in chunk records. */
  blob?: Blob;
  /** How many chunk records hold the bytes (see `chunkKey`). */
  chunkCount?: number;
  /** The bytes are a file in the origin private file system, not records here. */
  inOpfs?: boolean;
  mimeType?: string;
  createdAt: number;
  fileName: string | null;
}

/**
 * A streamed file is one small record at `id` plus chunk records at `chunkKey(id, n)`, so a big
 * file never has to be one value in memory. A chunk key starts with its attachment's id, then
 * this separator, which no id contains.
 */
const CHUNK_SEPARATOR = "\u0000";
// A chunk stays in memory until it has this many bytes, then goes to the database.
const CHUNK_FLUSH_BYTES = 8 * 1024 * 1024;

function chunkKey(id: string, index: number): string {
  return `${id}${CHUNK_SEPARATOR}${index}`;
}

function baseAttachmentId(key: string): string {
  const separatorAt = key.indexOf(CHUNK_SEPARATOR);
  return separatorAt === -1 ? key : key.slice(0, separatorAt);
}

const DB_NAME = "paseo-attachment-bytes";
const STORE_NAME = "attachments";
const DB_VERSION = 1;

function ensureIndexedDb(): IDBFactory {
  const idb = globalThis.indexedDB;
  if (!idb) {
    throw new Error("IndexedDB is unavailable in this runtime.");
  }
  return idb;
}

function openAttachmentDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = ensureIndexedDb().open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };

    request.addEventListener("success", () => {
      resolve(request.result);
    });

    request.addEventListener("error", () => {
      reject(request.error ?? new Error("Failed to open attachment IndexedDB."));
    });
  });
}

function runTx<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);
    const request = run(store);

    request.addEventListener("success", () => {
      resolve(request.result);
    });

    request.addEventListener("error", () => {
      reject(request.error ?? new Error("IndexedDB transaction request failed."));
    });

    transaction.addEventListener("error", () => {
      reject(transaction.error ?? new Error("IndexedDB transaction failed."));
    });
  });
}

async function sourceToBlob(input: SaveAttachmentInput): Promise<{ blob: Blob; mimeType: string }> {
  const source = input.source;
  if (source.kind === "bytes") {
    const mimeType = normalizeMimeType(input.mimeType);
    const buffer = new ArrayBuffer(source.bytes.byteLength);
    new Uint8Array(buffer).set(source.bytes);
    return {
      blob: new Blob([buffer], { type: mimeType }),
      mimeType,
    };
  }

  if (source.kind === "blob") {
    const mimeType = normalizeMimeType(input.mimeType ?? source.blob.type);
    const blob =
      source.blob.type === mimeType
        ? source.blob
        : source.blob.slice(0, source.blob.size, mimeType);
    return { blob, mimeType };
  }

  if (source.kind === "data_url") {
    const parsed = parseDataUrl(source.dataUrl);
    const response = await fetch(source.dataUrl);
    const blob = await response.blob();
    const mimeType = normalizeMimeType(input.mimeType ?? parsed.mimeType ?? blob.type);
    return {
      blob: blob.type === mimeType ? blob : blob.slice(0, blob.size, mimeType),
      mimeType,
    };
  }

  const response = await fetch(source.uri);
  const blob = await response.blob();
  const mimeType = normalizeMimeType(input.mimeType ?? blob.type);
  return {
    blob: blob.type === mimeType ? blob : blob.slice(0, blob.size, mimeType),
    mimeType,
  };
}

async function loadBlob(db: IDBDatabase, id: string): Promise<Blob> {
  const record = await runTx<StoredBlobRecord | undefined>(db, "readonly", (store) =>
    store.get(id),
  );
  if (record?.blob) {
    return record.blob;
  }
  if (record?.inOpfs) {
    // A File on disk: it is read as the page asks for it, never copied into memory.
    const directory = await opfsDirectory();
    const handle = await directory.getFileHandle(opfsFileName(id));
    return handle.getFile();
  }
  if (record?.chunkCount === undefined) {
    throw new Error(`Attachment ${id} was not found in IndexedDB.`);
  }
  // Chunk blobs are handles to the database's own storage; joining them copies nothing.
  const parts: Blob[] = [];
  for (let index = 0; index < record.chunkCount; index += 1) {
    const chunk = await runTx<StoredBlobRecord | undefined>(db, "readonly", (store) =>
      store.get(chunkKey(id, index)),
    );
    if (!chunk?.blob) {
      throw new Error(`Attachment ${id} is missing chunk ${index} in IndexedDB.`);
    }
    parts.push(chunk.blob);
  }
  return new Blob(parts, { type: record.mimeType });
}

/**
 * Where the browser can stream a file straight to disk (the origin private file system with
 * `createWritable`), a big file goes there and the browser never holds it. IndexedDB cannot do
 * that: Chromium keeps every blob written to it in the browser process for a while, about the
 * size of the whole file, which a 300 MB save showed. The record at `id` then only says
 * `inOpfs`.
 */
const OPFS_DIRECTORY = "paseo-attachments";

function isOpfsWritable(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.storage?.getDirectory === "function" &&
    typeof FileSystemFileHandle !== "undefined" &&
    "createWritable" in FileSystemFileHandle.prototype
  );
}

async function opfsDirectory(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(OPFS_DIRECTORY, { create: true });
}

function opfsFileName(id: string): string {
  return encodeURIComponent(id);
}

async function removeOpfsFile(id: string): Promise<void> {
  if (!isOpfsWritable()) {
    return;
  }
  try {
    await (await opfsDirectory()).removeEntry(opfsFileName(id));
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "NotFoundError")) {
      throw error;
    }
  }
}

/** Removes files no attachment refers to any more, such as one a closed tab left half written. */
async function removeUnreferencedOpfsFiles(referencedIds: ReadonlySet<string>): Promise<void> {
  if (!isOpfsWritable()) {
    return;
  }
  const directory = await opfsDirectory();
  const names: string[] = [];
  for await (const [name] of directory.entries()) {
    if (!referencedIds.has(decodeURIComponent(name))) {
      names.push(name);
    }
  }
  for (const name of names) {
    await directory.removeEntry(name);
  }
}

async function createOpfsWriter(input: OpenAttachmentWriterInput): Promise<AttachmentWriter> {
  const id = input.id ?? generateAttachmentId();
  const mimeType = normalizeMimeType(input.mimeType);
  const fileName = input.fileName ?? null;
  const createdAt = Date.now();
  const directory = await opfsDirectory();
  const handle = await directory.getFileHandle(opfsFileName(id), { create: true });
  const writable = await handle.createWritable();
  let size = 0;

  return {
    id,
    async write(chunk) {
      // Chunks come from WebSocket frames, which are never backed by a SharedArrayBuffer.
      const bytes = chunk as Uint8Array<ArrayBuffer>;
      await writable.write(bytes);
      size += chunk.byteLength;
    },
    async finish() {
      await writable.close();
      const db = await openAttachmentDb();
      try {
        await runTx(db, "readwrite", (store) =>
          store.put({
            id,
            inOpfs: true,
            mimeType,
            createdAt,
            fileName,
          } satisfies StoredBlobRecord),
        );
      } finally {
        db.close();
      }
      return {
        id,
        mimeType,
        storageType: "web-indexeddb",
        storageKey: id,
        fileName,
        byteSize: size,
        createdAt,
      };
    },
    async abort() {
      await writable.abort().catch(() => undefined);
      await removeOpfsFile(id);
    },
  };
}

function createChunkWriter(input: OpenAttachmentWriterInput): AttachmentWriter {
  const id = input.id ?? generateAttachmentId();
  const mimeType = normalizeMimeType(input.mimeType);
  const fileName = input.fileName ?? null;
  const createdAt = Date.now();
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let chunkCount = 0;
  let size = 0;

  async function flush(): Promise<void> {
    if (pending.length === 0) {
      return;
    }
    const parts = pending;
    pending = [];
    pendingBytes = 0;
    // Blob copies the bytes out of this process's heap.
    const blob = new Blob(parts as BlobPart[], { type: mimeType });
    const key = chunkKey(id, chunkCount);
    chunkCount += 1;
    const db = await openAttachmentDb();
    try {
      await runTx(db, "readwrite", (store) =>
        store.put({ id: key, blob, createdAt, fileName: null } satisfies StoredBlobRecord),
      );
    } finally {
      db.close();
    }
  }

  async function dropAll(): Promise<void> {
    const db = await openAttachmentDb();
    try {
      await deleteAttachmentRecords(db, id);
    } finally {
      db.close();
    }
  }

  return {
    id,
    async write(chunk) {
      pending.push(chunk);
      pendingBytes += chunk.byteLength;
      size += chunk.byteLength;
      if (pendingBytes >= CHUNK_FLUSH_BYTES) {
        await flush();
      }
    },
    async finish() {
      await flush();
      const db = await openAttachmentDb();
      try {
        await runTx(db, "readwrite", (store) =>
          store.put({
            id,
            chunkCount,
            mimeType,
            createdAt,
            fileName,
          } satisfies StoredBlobRecord),
        );
      } finally {
        db.close();
      }
      return {
        id,
        mimeType,
        storageType: "web-indexeddb",
        storageKey: id,
        fileName,
        byteSize: size,
        createdAt,
      };
    },
    async abort() {
      pending = [];
      pendingBytes = 0;
      await dropAll();
    },
  };
}

/** Deletes an attachment's record and every chunk record it owns. */
function deleteAttachmentRecords(db: IDBDatabase, id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.delete(id);
    store.delete(IDBKeyRange.bound(`${id}${CHUNK_SEPARATOR}`, `${id}${CHUNK_SEPARATOR}\uffff`));
    tx.addEventListener("complete", () => resolve());
    tx.addEventListener("error", () => {
      reject(tx.error ?? new Error("Failed to delete IndexedDB attachment."));
    });
  });
}

export function createIndexedDbAttachmentStore(): AttachmentStore {
  return {
    storageType: "web-indexeddb",

    async openWriter(input) {
      return isOpfsWritable() ? createOpfsWriter(input) : createChunkWriter(input);
    },

    async save(input): Promise<AttachmentMetadata> {
      const id = input.id ?? generateAttachmentId();
      const createdAt = Date.now();
      const { blob, mimeType } = await sourceToBlob(input);
      const fileName = input.fileName ?? null;
      const db = await openAttachmentDb();

      try {
        await runTx(db, "readwrite", (store) =>
          store.put({ id, blob, createdAt, fileName } satisfies StoredBlobRecord),
        );
      } finally {
        db.close();
      }

      return {
        id,
        mimeType,
        storageType: "web-indexeddb",
        storageKey: id,
        fileName,
        byteSize: blob.size,
        createdAt,
      };
    },

    async encodeBase64({ attachment }): Promise<string> {
      const db = await openAttachmentDb();
      try {
        const blob = await loadBlob(db, attachment.storageKey);
        return await blobToBase64(blob);
      } finally {
        db.close();
      }
    },

    async resolvePreviewUrl({ attachment }): Promise<string> {
      const db = await openAttachmentDb();
      try {
        const blob = await loadBlob(db, attachment.storageKey);
        return URL.createObjectURL(blob);
      } finally {
        db.close();
      }
    },

    async releasePreviewUrl({ url }): Promise<void> {
      URL.revokeObjectURL(url);
    },

    async delete({ attachment }): Promise<void> {
      const db = await openAttachmentDb();
      try {
        await deleteAttachmentRecords(db, attachment.storageKey);
      } finally {
        db.close();
      }
      await removeOpfsFile(attachment.storageKey);
    },

    async garbageCollect({ referencedIds }): Promise<void> {
      const db = await openAttachmentDb();
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, "readwrite");
          const store = tx.objectStore(STORE_NAME);
          const cursorRequest = store.openCursor();

          cursorRequest.addEventListener("error", () => {
            reject(
              cursorRequest.error ?? new Error("Failed to iterate IndexedDB attachment store."),
            );
          });

          cursorRequest.addEventListener("success", () => {
            const cursor = cursorRequest.result;
            if (!cursor) {
              resolve();
              return;
            }

            const key = String(cursor.key);
            if (!referencedIds.has(baseAttachmentId(key))) {
              cursor.delete();
            }
            cursor.continue();
          });

          tx.addEventListener("error", () => {
            reject(tx.error ?? new Error("Failed to garbage collect IndexedDB attachments."));
          });
        });
      } finally {
        db.close();
      }
      await removeUnreferencedOpfsFiles(referencedIds);
    },
  };
}
