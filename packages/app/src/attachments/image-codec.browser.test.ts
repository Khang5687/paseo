import { describe, expect, it } from "vitest";
import type { AttachmentMetadata } from "@/attachments/types";
import { blobToBase64 } from "@/attachments/utils";
import { downscaleAttachmentForSend } from "./image-codec";

async function picture(input: {
  width: number;
  height: number;
  mimeType: "image/png" | "image/jpeg";
}): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = input.width;
  canvas.height = input.height;
  const context = canvas.getContext("2d")!;
  const gradient = context.createLinearGradient(0, 0, input.width, input.height);
  gradient.addColorStop(0, "#1d4ed8");
  gradient.addColorStop(1, "#f59e0b");
  context.fillStyle = gradient;
  context.fillRect(0, 0, input.width, input.height);
  context.fillStyle = "#000000";
  context.font = "48px sans-serif";
  context.fillText("Screenshot text stays readable", 40, 120);
  const { promise, resolve } = Promise.withResolvers<Blob | null>();
  canvas.toBlob(resolve, input.mimeType, 0.95);
  return await blobToBase64((await promise)!);
}

async function decodedSize(data: string, mimeType: string) {
  const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: mimeType }));
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return size;
}

function stored(mimeType: string): AttachmentMetadata {
  return {
    id: "att_web",
    mimeType,
    storageType: "web-indexeddb",
    storageKey: "att_web",
    createdAt: 0,
  };
}

describe("web downscaleAttachmentForSend", () => {
  it("resizes a 4000x3000 picture to 2000x1500 JPEG", async () => {
    const original = await picture({ width: 4000, height: 3000, mimeType: "image/png" });

    const sent = await downscaleAttachmentForSend({
      attachment: stored("image/png"),
      readBase64: async () => original,
      sendOriginal: false,
    });

    expect(sent.mimeType).toBe("image/jpeg");
    expect(await decodedSize(sent.data, sent.mimeType)).toEqual({ width: 2000, height: 1500 });
    expect(sent.data.length).toBeLessThan(original.length);
  });

  it("sends a small JPEG byte for byte instead of upscaling it", async () => {
    const original = await picture({ width: 800, height: 600, mimeType: "image/jpeg" });

    await expect(
      downscaleAttachmentForSend({
        attachment: stored("image/jpeg"),
        readBase64: async () => original,
        sendOriginal: false,
      }),
    ).resolves.toEqual({ data: original, mimeType: "image/jpeg" });
  });

  it("sends the original when the switch is on", async () => {
    const original = await picture({ width: 4000, height: 3000, mimeType: "image/png" });

    await expect(
      downscaleAttachmentForSend({
        attachment: stored("image/png"),
        readBase64: async () => original,
        sendOriginal: true,
      }),
    ).resolves.toEqual({ data: original, mimeType: "image/png" });
  });
});
