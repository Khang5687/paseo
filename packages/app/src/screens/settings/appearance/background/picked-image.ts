import { getFileExtension } from "@/attachments/file-types";
import { fileUriToPath } from "@/attachments/utils";
import { getIsElectron } from "@/constants/platform";
import {
  copyDesktopAttachmentFile,
  deleteDesktopAttachmentFile,
} from "@/desktop/attachments/desktop-file-commands";
import { readDesktopFileBase64 } from "@/desktop/attachments/desktop-preview-url";
import type { PickedImageAttachmentInput } from "@/hooks/image-attachment-picker";
import type { SkinOriginal } from "@/skins/cache-core";
import { assertSkinImageByteLength } from "@/skins/image-limits";

export interface PickedSkinOriginal {
  original: SkinOriginal;
  release: () => void;
}

function noop(): void {}

/**
 * The desktop open dialog returns a filesystem path. The renderer cannot fetch it: the packaged
 * app serves its pages from a custom scheme, so `fetch(path)` resolves inside the app bundle.
 * The main process only reads files in its managed storage, so copy the file there, read it, and
 * delete the copy.
 */
async function readDesktopImage(uri: string, mimeType: string): Promise<SkinOriginal> {
  const path = fileUriToPath(uri);
  const copy = await copyDesktopAttachmentFile({
    attachmentId: globalThis.crypto.randomUUID(),
    sourcePath: path,
    extension: getFileExtension(path) || null,
  });
  try {
    // Checked before the read so an oversized file never crosses into the renderer.
    assertSkinImageByteLength(copy.byteSize);
    return { kind: "base64", base64: await readDesktopFileBase64(copy.path), mimeType };
  } finally {
    await deleteDesktopAttachmentFile({ path: copy.path });
  }
}

/** Turns a picked image into the original bytes the skin cache stores. */
export async function resolvePickedSkinOriginal(
  picked: PickedImageAttachmentInput,
): Promise<PickedSkinOriginal> {
  const { mimeType } = picked;
  switch (picked.source.kind) {
    case "file_uri":
      return {
        original: getIsElectron()
          ? await readDesktopImage(picked.source.uri, mimeType)
          : { kind: "uri", uri: picked.source.uri, mimeType },
        release: noop,
      };
    case "data_url":
      return { original: { kind: "uri", uri: picked.source.dataUrl, mimeType }, release: noop };
    case "blob": {
      const uri = URL.createObjectURL(picked.source.blob);
      return {
        original: { kind: "uri", uri, mimeType },
        release: () => URL.revokeObjectURL(uri),
      };
    }
  }
}
