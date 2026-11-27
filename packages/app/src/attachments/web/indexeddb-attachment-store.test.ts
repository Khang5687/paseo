import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIndexedDbAttachmentStore } from "./indexeddb-attachment-store";

type Listener = () => void;

class FakeRequest {
  result!: unknown;
  error: Error | null = null;
  private listeners = new Map<string, Listener[]>();

  addEventListener(event: string, listener: Listener): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }

  emit(event: string): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener();
    }
  }
}

class FakeObjectStore {
  constructor(private readonly onPut: (record: unknown) => void) {}

  put(record: unknown): FakeRequest {
    this.onPut(record);
    const request = new FakeRequest();
    queueMicrotask(() => request.emit("success"));
    return request;
  }
}

class FakeTransaction {
  error: Error | null = null;

  constructor(private readonly store: FakeObjectStore) {}

  objectStore(): FakeObjectStore {
    return this.store;
  }

  addEventListener(): void {}
}

class FakeDatabase {
  readonly objectStoreNames = {
    contains: () => true,
  };

  constructor(private readonly store: FakeObjectStore) {}

  createObjectStore(): void {}

  transaction(): FakeTransaction {
    return new FakeTransaction(this.store);
  }

  close(): void {}
}

describe("indexeddb attachment store", () => {
  let storedRecord: unknown;
  let storedRecords: Array<{ id: string; blob?: Blob; chunkCount?: number }>;

  beforeEach(() => {
    storedRecord = null;
    storedRecords = [];
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: {
        open: () => {
          const store = new FakeObjectStore((record) => {
            storedRecord = record;
            storedRecords.push(record as { id: string; blob?: Blob; chunkCount?: number });
          });
          const request = new FakeRequest();
          request.result = new FakeDatabase(store);
          queueMicrotask(() => request.emit("success"));
          return request;
        },
      } as unknown as IDBFactory,
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "indexedDB");
  });

  it("stores raw byte sources as a Blob", async () => {
    const store = createIndexedDbAttachmentStore();
    const bytes = new Uint8Array([0, 1, 2, 3]);

    const attachment = await store.save({
      id: "att_bytes",
      mimeType: "image/png",
      fileName: "image.png",
      source: { kind: "bytes", bytes },
    });

    expect(storedRecord).toEqual({
      id: "att_bytes",
      blob: new Blob([bytes], { type: "image/png" }),
      createdAt: expect.any(Number),
      fileName: "image.png",
    });
    expect(attachment).toMatchObject({
      id: "att_bytes",
      mimeType: "image/png",
      storageType: "web-indexeddb",
      storageKey: "att_bytes",
      fileName: "image.png",
      byteSize: 4,
    });
  });

  it("writes a big file as chunk records, then a record that names them", async () => {
    const store = createIndexedDbAttachmentStore();
    const MB = 1024 * 1024;
    const piece = new Uint8Array(MB).fill(9);

    const writer = await store.openWriter({
      id: "att_big",
      mimeType: "video/mp4",
      fileName: "clip.mp4",
    });
    for (let index = 0; index < 20; index += 1) {
      await writer.write(piece);
    }
    const attachment = await writer.finish();

    // The file is never one record: no single IndexedDB write holds more than 8 MB of it.
    expect(storedRecords.map((record) => record.id)).toEqual([
      "att_big\u00000",
      "att_big\u00001",
      "att_big\u00002",
      "att_big",
    ]);
    expect(storedRecords.slice(0, 3).map((record) => record.blob?.size)).toEqual([
      8 * MB,
      8 * MB,
      4 * MB,
    ]);
    expect(storedRecords[3]).toMatchObject({ chunkCount: 3 });
    expect(attachment).toMatchObject({
      id: "att_big",
      mimeType: "video/mp4",
      storageType: "web-indexeddb",
      storageKey: "att_big",
      byteSize: 20 * MB,
    });
  });

  describe("where the browser can write to disk", () => {
    const MB = 1024 * 1024;

    class FakeWritable {
      written = 0;
      aborted = false;
      closed = false;
      async write(chunk: Uint8Array): Promise<void> {
        this.written += chunk.byteLength;
      }
      async close(): Promise<void> {
        this.closed = true;
      }
      async abort(): Promise<void> {
        this.aborted = true;
      }
    }

    let writable: FakeWritable;
    let removed: string[];

    beforeEach(() => {
      writable = new FakeWritable();
      removed = [];
      const directory = {
        getFileHandle: async () => ({ createWritable: async () => writable }),
        removeEntry: async (name: string) => {
          removed.push(name);
        },
      };
      vi.stubGlobal(
        "FileSystemFileHandle",
        class {
          createWritable(): void {}
        },
      );
      vi.stubGlobal("navigator", {
        storage: { getDirectory: async () => ({ getDirectoryHandle: async () => directory }) },
      });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("streams a big file to a file on disk and keeps only a small record in IndexedDB", async () => {
      const store = createIndexedDbAttachmentStore();
      const writer = await store.openWriter({
        id: "att_big",
        mimeType: "video/mp4",
        fileName: "clip.mp4",
      });
      const piece = new Uint8Array(MB);
      for (let index = 0; index < 20; index += 1) {
        await writer.write(piece);
      }
      const attachment = await writer.finish();

      // Every chunk went to the disk file as it arrived; none was held back.
      expect(writable.written).toBe(20 * MB);
      expect(writable.closed).toBe(true);
      expect(storedRecords).toEqual([
        {
          id: "att_big",
          inOpfs: true,
          mimeType: "video/mp4",
          createdAt: expect.any(Number),
          fileName: "clip.mp4",
        },
      ]);
      expect(attachment).toMatchObject({ id: "att_big", byteSize: 20 * MB });
    });

    it("removes the half-written file when the transfer is abandoned", async () => {
      const store = createIndexedDbAttachmentStore();
      const writer = await store.openWriter({ id: "att_big", mimeType: "video/mp4" });
      await writer.write(new Uint8Array(MB));
      await writer.abort();

      expect(writable.aborted).toBe(true);
      expect(removed).toEqual(["att_big"]);
      expect(storedRecords).toEqual([]);
    });
  });
});
