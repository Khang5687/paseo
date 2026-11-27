export const MAX_SKIN_BYTES = 16 * 1024 * 1024;
export const MAX_SKIN_SIDE = 16384;
export const MAX_SKIN_PIXELS = 50_000_000;
export const SKIN_DISPLAY_MAX_SIDE = 2560;
export const SKIN_SMALL_MAX_SIDE = 640;

export type SkinImageFormat = "png" | "jpeg" | "webp";

export interface SkinImageDimensions {
  width: number;
  height: number;
}

export interface SkinImageInfo extends SkinImageDimensions {
  format: SkinImageFormat;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function matchesAt(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  if (bytes.length < offset + expected.length) return false;
  return expected.every((value, index) => bytes[offset + index] === value);
}

function asciiBytes(text: string): number[] {
  return Array.from(text, (char) => char.charCodeAt(0));
}

const RIFF = asciiBytes("RIFF");
const WEBP = asciiBytes("WEBP");

export function sniffImageFormat(bytes: Uint8Array): SkinImageFormat | null {
  if (matchesAt(bytes, 0, PNG_SIGNATURE)) return "png";
  if (matchesAt(bytes, 0, [0xff, 0xd8, 0xff])) return "jpeg";
  if (matchesAt(bytes, 0, RIFF) && matchesAt(bytes, 8, WEBP)) return "webp";
  return null;
}

function u16be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function u16le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function u24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function readPngDimensions(bytes: Uint8Array): SkinImageDimensions | null {
  if (bytes.length < 24 || !matchesAt(bytes, 12, asciiBytes("IHDR"))) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function isJpegStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function readJpegDimensions(bytes: Uint8Array): SkinImageDimensions | null {
  let position = 2;
  while (position + 4 <= bytes.length) {
    if (bytes[position] !== 0xff) return null;
    const marker = bytes[position + 1];
    if (marker === 0xff) {
      position += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      position += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const segmentLength = u16be(bytes, position + 2);
    if (isJpegStartOfFrame(marker)) {
      if (position + 9 > bytes.length) return null;
      return { width: u16be(bytes, position + 7), height: u16be(bytes, position + 5) };
    }
    if (segmentLength < 2) return null;
    position += 2 + segmentLength;
  }
  return null;
}

function readWebpDimensions(bytes: Uint8Array): SkinImageDimensions | null {
  if (bytes.length < 30) return null;
  if (matchesAt(bytes, 12, asciiBytes("VP8X"))) {
    return { width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 };
  }
  if (matchesAt(bytes, 12, asciiBytes("VP8L"))) {
    if (bytes[20] !== 0x2f) return null;
    const packed = (bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24)) >>> 0;
    return { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 };
  }
  if (matchesAt(bytes, 12, asciiBytes("VP8 "))) {
    if (!matchesAt(bytes, 23, [0x9d, 0x01, 0x2a])) return null;
    return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
  }
  return null;
}

export function readImageDimensions(
  bytes: Uint8Array,
  format: SkinImageFormat,
): SkinImageDimensions | null {
  if (format === "png") return readPngDimensions(bytes);
  if (format === "jpeg") return readJpegDimensions(bytes);
  return readWebpDimensions(bytes);
}

export function assertSkinImageDimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error("Image dimensions are invalid");
  }
  if (width > MAX_SKIN_SIDE || height > MAX_SKIN_SIDE) {
    throw new Error(`Image is larger than ${MAX_SKIN_SIDE} px on a side`);
  }
  if (width * height > MAX_SKIN_PIXELS) {
    throw new Error("Image has more than 50 megapixels");
  }
}

export function assertSkinImageByteLength(byteLength: number): void {
  if (byteLength <= 0) throw new Error("Image is empty");
  if (byteLength > MAX_SKIN_BYTES) throw new Error("Image is larger than 16 MiB");
}

/** Validates the complete original file before any decoder sees it. */
export function inspectSkinImage(bytes: Uint8Array): SkinImageInfo {
  assertSkinImageByteLength(bytes.byteLength);
  const format = sniffImageFormat(bytes);
  if (!format) throw new Error("Unsupported image format. Use PNG, JPEG or WebP");
  const dimensions = readImageDimensions(bytes, format);
  if (!dimensions) throw new Error("Image header is unreadable");
  assertSkinImageDimensions(dimensions.width, dimensions.height);
  return { format, ...dimensions };
}

/** Upper bound of decoded bytes for a base64 string, without decoding it. */
export function base64DecodedLength(base64: string): number {
  let padding = 0;
  if (base64.endsWith("==")) padding = 2;
  else if (base64.endsWith("=")) padding = 1;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/** Scales down so the long side is at most `maxSide`; never upscales. */
export function fitLongSide(width: number, height: number, maxSide: number): SkinImageDimensions {
  const longSide = Math.max(width, height);
  if (longSide <= maxSide) return { width, height };
  const scale = maxSide / longSide;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

const MAX_SKIN_ID_BYTES = 120;

/** Reversible, filesystem-safe encoding of a skin id (ids contain `/` and `:`). */
export function encodeSkinIdForPath(id: string): string {
  const bytes = new TextEncoder().encode(id);
  if (bytes.length === 0 || bytes.length > MAX_SKIN_ID_BYTES) {
    throw new Error("Skin id must be 1–120 bytes");
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
