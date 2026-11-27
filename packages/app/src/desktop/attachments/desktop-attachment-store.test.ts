import { describe, expect, it } from "vitest";
import { createDesktopAttachmentStore } from "./desktop-attachment-store";
import { createFakeDesktopAttachmentBridge } from "./test-utils/fake-desktop-attachment-bridge";

describe("desktop attachment store", () => {
  it("saves dropped file paths as desktop-file metadata", async () => {
    const fake = createFakeDesktopAttachmentBridge();
    const store = createDesktopAttachmentStore(fake.bridge);

    const attachment = await store.save({
      id: "att_1",
      mimeType: "image/png",
      source: {
        kind: "file_uri",
        uri: "file:///Users/test/Desktop/image.png",
      },
    });

    expect(fake.savedEntries).toEqual([
      {
        attachmentId: "att_1",
        path: "/managed/att_1.png",
        byteSize: 4,
        extension: ".png",
        source: { kind: "copy", sourcePath: "/Users/test/Desktop/image.png" },
      },
    ]);
    expect(attachment).toMatchObject({
      storageType: "desktop-file",
      storageKey: "/managed/att_1.png",
    });
  });

  it("saves blob/data-url sources via desktop filesystem writes", async () => {
    const fake = createFakeDesktopAttachmentBridge();
    const store = createDesktopAttachmentStore(fake.bridge);

    await store.save({
      id: "att_2",
      source: {
        kind: "data_url",
        dataUrl: "data:image/png;base64,AAECAw==",
      },
    });

    expect(fake.savedEntries).toEqual([
      {
        attachmentId: "att_2",
        path: "/managed/att_2.png",
        byteSize: 4,
        extension: ".png",
        source: { kind: "base64", base64: "AAECAw==" },
      },
    ]);
  });

  it("saves raw byte sources via desktop filesystem writes", async () => {
    const fake = createFakeDesktopAttachmentBridge();
    const store = createDesktopAttachmentStore(fake.bridge);
    const bytes = new Uint8Array([0, 1, 2, 3]);

    const attachment = await store.save({
      id: "att_bytes",
      mimeType: "image/png",
      fileName: "inline.png",
      source: {
        kind: "bytes",
        bytes,
      },
    });

    expect(fake.savedEntries).toEqual([
      {
        attachmentId: "att_bytes",
        path: "/managed/att_bytes.png",
        byteSize: 4,
        extension: ".png",
        source: { kind: "bytes", bytes },
      },
    ]);
    expect(attachment).toMatchObject({
      id: "att_bytes",
      mimeType: "image/png",
      storageType: "desktop-file",
      storageKey: "/managed/att_bytes.png",
      fileName: "inline.png",
      byteSize: 4,
    });
  });

  it("writes a big file to the desktop in 4 MB steps and abandons it cleanly", async () => {
    const fake = createFakeDesktopAttachmentBridge();
    const store = createDesktopAttachmentStore(fake.bridge);
    const MB = 1024 * 1024;

    const writer = await store.openWriter({
      id: "att_big",
      mimeType: "video/mp4",
      fileName: "clip.mp4",
    });
    for (let index = 0; index < 5; index += 1) {
      await writer.write(new Uint8Array(MB).fill(index + 1));
    }
    const attachment = await writer.finish();

    expect(fake.savedEntries).toHaveLength(1);
    const [entry] = fake.savedEntries;
    expect(entry).toMatchObject({ path: "/managed/att_big.mp4", byteSize: 5 * MB });
    expect(entry?.source.kind === "bytes" && entry.source.bytes[0]).toBe(1);
    expect(entry?.source.kind === "bytes" && entry.source.bytes[5 * MB - 1]).toBe(5);
    expect(attachment).toMatchObject({
      id: "att_big",
      mimeType: "video/mp4",
      storageType: "desktop-file",
      storageKey: "/managed/att_big.mp4",
      byteSize: 5 * MB,
    });

    const abandoned = await store.openWriter({
      id: "att_stop",
      mimeType: "video/mp4",
      fileName: "stop.mp4",
    });
    await abandoned.write(new Uint8Array(5 * MB));
    await abandoned.abort();
    expect(fake.deletedPaths).toEqual(["/managed/att_stop.mp4"]);
  });

  it("delegates encode/preview/delete/gc to desktop command path", async () => {
    const fake = createFakeDesktopAttachmentBridge();
    const store = createDesktopAttachmentStore(fake.bridge);
    const attachment = {
      id: "att_3",
      mimeType: "image/jpeg",
      storageType: "desktop-file" as const,
      storageKey: "/managed/att_3.jpg",
      createdAt: Date.now(),
    };

    await store.encodeBase64({ attachment });
    await store.resolvePreviewUrl({ attachment });
    await store.releasePreviewUrl?.({ attachment, url: "blob:test" });
    await store.delete({ attachment });
    await store.garbageCollect({ referencedIds: new Set(["att_3"]) });

    expect(fake.readBase64Calls).toEqual(["/managed/att_3.jpg"]);
    expect(fake.resolvedPreviewUrls).toEqual([attachment]);
    expect(fake.releasedPreviewUrls).toEqual(["blob:test"]);
    expect(fake.deletedPaths).toEqual(["/managed/att_3.jpg"]);
    expect(fake.garbageCollections).toEqual([{ referencedIds: ["att_3"] }]);
  });
});
