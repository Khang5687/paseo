import { describe, expect, it } from "vitest";
import {
  base64DecodedLength,
  encodeSkinIdForPath,
  fitLongSide,
  inspectSkinImage,
  MAX_SKIN_BYTES,
  readImageDimensions,
  sniffImageFormat,
} from "./image-limits";
import { measureLuminance, relativeLuminance } from "./luminance";
import { DEFAULT_SKIN_PREFERENCES, skinPreferencesSchema } from "./preferences-schema";

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function jpegHeader(width: number, height: number): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...Array.from({ length: 14 }, () => 0)];
  const sof = [
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    1,
    1,
    0x11,
    0,
  ];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof]);
}

function webpVp8x(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], 0);
  bytes.set([0x56, 0x50, 0x38, 0x58, 10, 0, 0, 0], 12);
  const w = width - 1;
  const h = height - 1;
  bytes.set(
    [w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff, h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff],
    24,
  );
  return bytes;
}

describe("image header sniffing", () => {
  it("identifies PNG, JPEG and WebP by magic bytes and rejects others", () => {
    expect(sniffImageFormat(pngHeader(1, 1))).toBe("png");
    expect(sniffImageFormat(jpegHeader(1, 1))).toBe("jpeg");
    expect(sniffImageFormat(webpVp8x(1, 1))).toBe("webp");
    expect(sniffImageFormat(new TextEncoder().encode("<svg xmlns='x'/>"))).toBeNull();
    expect(sniffImageFormat(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBeNull();
  });

  it("reads dimensions from each format header", () => {
    expect(readImageDimensions(pngHeader(3840, 2160), "png")).toEqual({
      width: 3840,
      height: 2160,
    });
    expect(readImageDimensions(jpegHeader(1920, 1080), "jpeg")).toEqual({
      width: 1920,
      height: 1080,
    });
    expect(readImageDimensions(webpVp8x(2560, 1440), "webp")).toEqual({
      width: 2560,
      height: 1440,
    });
  });
});

describe("inspectSkinImage", () => {
  it("accepts an image inside the limits", () => {
    expect(inspectSkinImage(pngHeader(7680, 4320))).toEqual({
      format: "png",
      width: 7680,
      height: 4320,
    });
  });

  it("rejects more than 50 megapixels", () => {
    expect(() => inspectSkinImage(pngHeader(8000, 6251))).toThrow("50 megapixels");
  });

  it("rejects a side above 16384 px", () => {
    expect(() => inspectSkinImage(pngHeader(16385, 10))).toThrow("16384");
  });

  it("rejects unknown formats and unreadable headers", () => {
    expect(() => inspectSkinImage(new Uint8Array([1, 2, 3, 4]))).toThrow("Unsupported");
    expect(() => inspectSkinImage(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toThrow("unreadable");
    expect(() => inspectSkinImage(new Uint8Array(0))).toThrow("empty");
  });

  it("rejects files above 16 MiB", () => {
    const bytes = new Uint8Array(MAX_SKIN_BYTES + 1);
    bytes.set(pngHeader(10, 10));
    expect(() => inspectSkinImage(bytes)).toThrow("16 MiB");
  });
});

describe("sizing helpers", () => {
  it("fits the long side without upscaling", () => {
    expect(fitLongSide(5120, 2880, 2560)).toEqual({ width: 2560, height: 1440 });
    expect(fitLongSide(1000, 4000, 640)).toEqual({ width: 160, height: 640 });
    expect(fitLongSide(800, 600, 2560)).toEqual({ width: 800, height: 600 });
  });

  it("computes decoded base64 length", () => {
    expect(base64DecodedLength(btoa("hello"))).toBe(5);
    expect(base64DecodedLength(btoa("hell"))).toBe(4);
  });

  it("encodes skin ids into path-safe, distinct names", () => {
    const a = encodeSkinIdForPath("plugin/skin/a:b");
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeSkinIdForPath("plugin/skin/a:c")).not.toBe(a);
    expect(() => encodeSkinIdForPath("")).toThrow();
    expect(() => encodeSkinIdForPath("x".repeat(121))).toThrow();
  });
});

describe("measureLuminance", () => {
  function solid(count: number, rgb: [number, number, number]): number[] {
    return Array.from({ length: count }, () => [...rgb, 255]).flat();
  }

  it("computes WCAG relative luminance", () => {
    expect(relativeLuminance(0, 0, 0)).toBe(0);
    expect(relativeLuminance(255, 255, 255)).toBeCloseTo(1, 6);
    expect(relativeLuminance(255, 0, 0)).toBeCloseTo(0.2126, 4);
  });

  it("takes P1 and P99, ignoring a few outliers", () => {
    const data = [
      ...solid(1, [0, 0, 0]),
      ...solid(98, [128, 128, 128]),
      ...solid(1, [255, 255, 255]),
    ];
    const result = measureLuminance(data);
    const mid = relativeLuminance(128, 128, 128);
    expect(result?.low).toBeCloseTo(mid, 6);
    expect(result?.high).toBeCloseTo(mid, 6);
  });

  it("reports the extremes of a bimodal image", () => {
    const result = measureLuminance([...solid(50, [0, 0, 0]), ...solid(50, [255, 255, 255])]);
    expect(result?.low).toBe(0);
    expect(result?.high).toBeCloseTo(1, 6);
  });

  it("ignores fully transparent pixels and returns null when nothing is visible", () => {
    expect(measureLuminance([255, 255, 255, 0, 0, 0, 0, 0])).toBeNull();
    const result = measureLuminance([255, 255, 255, 0, 0, 0, 0, 255]);
    expect(result).toEqual({ low: 0, high: 0 });
  });
});

describe("skinPreferencesSchema", () => {
  it("accepts the defaults", () => {
    expect(skinPreferencesSchema.parse(DEFAULT_SKIN_PREFERENCES)).toEqual(DEFAULT_SKIN_PREFERENCES);
  });

  it("clamps visibility into 0–1", () => {
    expect(
      skinPreferencesSchema.parse({ ...DEFAULT_SKIN_PREFERENCES, visibility: 4 }).visibility,
    ).toBe(1);
    expect(
      skinPreferencesSchema.parse({ ...DEFAULT_SKIN_PREFERENCES, visibility: -2 }).visibility,
    ).toBe(0);
  });

  it("falls back per field instead of discarding everything", () => {
    const parsed = skinPreferencesSchema.parse({
      selection: { light: "local:abc", dark: 5 },
      visibility: "high",
      blur: "extreme",
      showBehindSidebar: false,
      showBehindContent: "yes",
    });
    expect(parsed).toEqual({
      selection: { light: "local:abc", dark: null },
      visibility: 1,
      blur: "off",
      showBehindSidebar: false,
      showBehindContent: true,
    });
  });

  it("rejects unknown keys", () => {
    expect(skinPreferencesSchema.safeParse({ ...DEFAULT_SKIN_PREFERENCES, extra: 1 }).success).toBe(
      false,
    );
  });
});
