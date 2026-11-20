import { describe, expect, it } from "vitest";
import { planImageDownscale } from "./image-downscale";

describe("planImageDownscale", () => {
  it("shrinks a phone photo to 2000 px on its long side as JPEG", () => {
    expect(
      planImageDownscale({
        width: 4032,
        height: 3024,
        mimeType: "image/jpeg",
        sendOriginal: false,
      }),
    ).toEqual({ kind: "encode", width: 2000, height: 1500, mimeType: "image/jpeg", quality: 0.85 });
    expect(
      planImageDownscale({
        width: 3024,
        height: 4032,
        mimeType: "image/heic",
        sendOriginal: false,
      }),
    ).toEqual({ kind: "encode", width: 1500, height: 2000, mimeType: "image/jpeg", quality: 0.85 });
  });

  it("never upscales and leaves a small JPEG untouched", () => {
    expect(
      planImageDownscale({ width: 1200, height: 800, mimeType: "image/jpeg", sendOriginal: false }),
    ).toEqual({ kind: "keep" });
  });

  it("re-encodes a small PNG as JPEG at its own size", () => {
    expect(
      planImageDownscale({ width: 1200, height: 800, mimeType: "image/png", sendOriginal: false }),
    ).toEqual({ kind: "encode", width: 1200, height: 800, mimeType: "image/jpeg", quality: 0.85 });
  });

  it("sends the original when the switch is on", () => {
    expect(
      planImageDownscale({ width: 4032, height: 3024, mimeType: "image/png", sendOriginal: true }),
    ).toEqual({ kind: "keep" });
  });

  it("keeps a GIF so its animation survives", () => {
    expect(
      planImageDownscale({ width: 4000, height: 3000, mimeType: "image/gif", sendOriginal: false }),
    ).toEqual({ kind: "keep" });
  });
});
