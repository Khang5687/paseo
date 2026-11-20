/**
 * Pictures are resized on the device before send so many of them fit one message.
 * 2000 px matches the largest picture Claude accepts once a request holds more than
 * 20 images; bigger pictures are downsampled by the model anyway.
 */
export const IMAGE_MAX_LONG_SIDE_PX = 2000;
export const IMAGE_JPEG_QUALITY = 0.85;

export type ImageDownscalePlan =
  | { kind: "keep" }
  | { kind: "encode"; width: number; height: number; mimeType: "image/jpeg"; quality: number };

// GIF stays as is: re-encoding drops its animation. Vector and unknown types are not decoded.
const ENCODABLE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/bmp",
  "image/tiff",
]);

export function isDownscalableImageMimeType(mimeType: string): boolean {
  return ENCODABLE_MIME_TYPES.has(mimeType.toLowerCase());
}

export function planImageDownscale(input: {
  width: number;
  height: number;
  mimeType: string;
  sendOriginal: boolean;
}): ImageDownscalePlan {
  if (input.sendOriginal || !isDownscalableImageMimeType(input.mimeType)) return { kind: "keep" };
  if (!(input.width > 0) || !(input.height > 0)) return { kind: "keep" };
  const longSide = Math.max(input.width, input.height);
  const scale = Math.min(1, IMAGE_MAX_LONG_SIDE_PX / longSide);
  const mimeType = input.mimeType.toLowerCase();
  if (scale === 1 && (mimeType === "image/jpeg" || mimeType === "image/jpg")) {
    return { kind: "keep" };
  }
  return {
    kind: "encode",
    width: Math.max(1, Math.round(input.width * scale)),
    height: Math.max(1, Math.round(input.height * scale)),
    mimeType: "image/jpeg",
    quality: IMAGE_JPEG_QUALITY,
  };
}
