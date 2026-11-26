import { blobToBase64 } from "@/attachments/utils";
import { isDownscalableImageMimeType, planImageDownscale } from "@/attachments/image-downscale";
import type { DownscaleForSendInput, EncodedImage } from "@/attachments/image-codec.types";

function base64ToBlob(data: string, mimeType: string): Blob {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mimeType });
}

async function encodeJpeg(input: {
  bitmap: ImageBitmap;
  width: number;
  height: number;
  quality: number;
}): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = input.width;
  canvas.height = input.height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  // JPEG has no alpha: flatten transparent pixels onto white instead of black.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, input.width, input.height);
  context.imageSmoothingQuality = "high";
  context.drawImage(input.bitmap, 0, 0, input.width, input.height);
  // Not Promise.withResolvers: Safari before 17.4 lacks it, and this runs in phone browsers.
  return await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/jpeg", input.quality);
  });
}

/** Web and Electron: decode with the browser, resize on a canvas, encode JPEG. */
export async function downscaleAttachmentForSend(
  input: DownscaleForSendInput,
): Promise<EncodedImage> {
  const original: EncodedImage = {
    data: await input.readBase64(),
    mimeType: input.attachment.mimeType,
  };
  if (input.attachment.sendOriginal === true || !isDownscalableImageMimeType(original.mimeType)) {
    return original;
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(base64ToBlob(original.data, original.mimeType));
  } catch (error) {
    // Formats the browser cannot decode (HEIC in Chrome) go as they are; the size check still applies.
    console.warn("[attachments] Could not decode image for resizing", {
      id: input.attachment.id,
      error,
    });
    return original;
  }
  try {
    const plan = planImageDownscale({
      width: bitmap.width,
      height: bitmap.height,
      mimeType: original.mimeType,
    });
    if (plan.kind === "keep") return original;
    const blob = await encodeJpeg({
      bitmap,
      width: plan.width,
      height: plan.height,
      quality: plan.quality,
    });
    if (!blob) return original;
    return { data: await blobToBase64(blob), mimeType: plan.mimeType };
  } finally {
    bitmap.close();
  }
}
