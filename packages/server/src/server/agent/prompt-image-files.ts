import { writeFile } from "node:fs/promises";
import type { InlineAttachmentRef } from "@getpaseo/protocol/messages";
import { createUploadFile } from "../file-upload/upload-location.js";

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
};

/**
 * Pasted pictures reach the daemon as base64. Providers take that data as is, so the agent has
 * no file to copy into a project. Save each one as `image-<N>.<ext>` in the upload folder, with
 * N matching its `[Image #N]` label, and return the paths in image order for the prompt notes.
 * Call once per message, before the prompt goes to any provider.
 */
export async function saveInlineImages(
  paseoHome: string,
  images: ReadonlyArray<{ data: string; mimeType: string }> | undefined,
  attachmentRefs: readonly InlineAttachmentRef[] | undefined,
): Promise<string[] | undefined> {
  if (!images || images.length === 0) return undefined;
  const paths: string[] = [];
  for (const [index, image] of images.entries()) {
    const label = attachmentRefs?.find((ref) => ref.imageIndex === index)?.label;
    const number = /#(\d+)$/.exec(label ?? "")?.[1] ?? String(index + 1);
    const extension = IMAGE_EXTENSIONS[image.mimeType.toLowerCase()] ?? "img";
    const file = await createUploadFile(paseoHome, `image-${number}.${extension}`);
    await writeFile(file.path, Buffer.from(image.data, "base64"));
    paths.push(file.path);
  }
  return paths;
}
