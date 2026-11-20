import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AttachmentMetadata } from "@/attachments/types";
import { downscaleAttachmentForSend } from "./image-codec.native";

const manipulator = vi.hoisted(() => {
  const calls: { manipulate: unknown[]; resize: unknown[]; save: unknown[] } = {
    manipulate: [],
    resize: [],
    save: [],
  };
  const state = { width: 0, height: 0 };
  const image = (width: number, height: number) => ({
    width,
    height,
    release() {},
    async saveAsync(options: unknown) {
      calls.save.push({ width, height, options });
      return { uri: "file:///cache/out.jpg", width, height, base64: `resized-${width}x${height}` };
    },
  });
  const context = (size: { width: number; height: number }) => ({
    release() {},
    resize(next: { width: number; height: number }) {
      calls.resize.push(next);
      return context(next);
    },
    async renderAsync() {
      return image(size.width, size.height);
    },
  });
  return {
    calls,
    state,
    ImageManipulator: {
      manipulate(source: unknown) {
        calls.manipulate.push(source);
        return context({ width: state.width, height: state.height });
      },
    },
  };
});

vi.mock("expo-image-manipulator", () => ({
  ImageManipulator: manipulator.ImageManipulator,
  SaveFormat: { JPEG: "jpeg", PNG: "png" },
}));

function nativePicture(mimeType: string): AttachmentMetadata {
  return {
    id: "att_native",
    mimeType,
    storageType: "native-file",
    storageKey: "/data/paseo-native-attachments/att_native",
    createdAt: 0,
  };
}

const readBase64 = async () => "original-bytes";

describe("native downscaleAttachmentForSend", () => {
  beforeEach(() => {
    manipulator.calls.manipulate.length = 0;
    manipulator.calls.resize.length = 0;
    manipulator.calls.save.length = 0;
  });

  it("resizes a stored photo to 2000 px and sends JPEG", async () => {
    manipulator.state.width = 4032;
    manipulator.state.height = 3024;

    await expect(
      downscaleAttachmentForSend({
        attachment: nativePicture("image/png"),
        readBase64,
        sendOriginal: false,
      }),
    ).resolves.toEqual({ data: "resized-2000x1500", mimeType: "image/jpeg" });
    expect(manipulator.calls.manipulate[0]).toBe(
      "file:///data/paseo-native-attachments/att_native",
    );
    expect(manipulator.calls.resize).toEqual([{ width: 2000, height: 1500 }]);
    expect(manipulator.calls.save).toEqual([
      { width: 2000, height: 1500, options: { format: "jpeg", compress: 0.85, base64: true } },
    ]);
  });

  it("sends a small JPEG unchanged instead of upscaling it", async () => {
    manipulator.state.width = 1200;
    manipulator.state.height = 900;

    await expect(
      downscaleAttachmentForSend({
        attachment: nativePicture("image/jpeg"),
        readBase64,
        sendOriginal: false,
      }),
    ).resolves.toEqual({ data: "original-bytes", mimeType: "image/jpeg" });
    expect(manipulator.calls.resize).toEqual([]);
  });

  it("sends the stored bytes untouched when the original-size switch is on", async () => {
    manipulator.state.width = 4032;
    manipulator.state.height = 3024;

    await expect(
      downscaleAttachmentForSend({
        attachment: nativePicture("image/jpeg"),
        readBase64,
        sendOriginal: true,
      }),
    ).resolves.toEqual({ data: "original-bytes", mimeType: "image/jpeg" });
    expect(manipulator.calls.manipulate).toEqual([]);
  });
});
