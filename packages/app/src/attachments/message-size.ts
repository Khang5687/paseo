import { MAX_WEBSOCKET_MESSAGE_BYTES } from "@getpaseo/protocol/websocket-message-limit";
import { i18n } from "@/i18n/i18next";

// Room for the message text and the JSON envelope around the pictures.
const MESSAGE_ENVELOPE_RESERVE_BYTES = 1024 * 1024;
// Each picture adds `{"data":"","mimeType":""},` around its payload.
const PER_IMAGE_OVERHEAD_BYTES = 32;

/** Largest total of encoded pictures one message can carry. */
export const MAX_MESSAGE_ATTACHMENT_BYTES =
  MAX_WEBSOCKET_MESSAGE_BYTES - MESSAGE_ENVELOPE_RESERVE_BYTES;

const BYTES_PER_MB = 1024 * 1024;

export class AttachmentsTooLargeError extends Error {
  constructor(
    readonly bytes: number,
    readonly limitBytes: number,
  ) {
    super(
      i18n.t("composer.errors.attachmentsTooLarge", {
        size: Math.ceil(bytes / BYTES_PER_MB),
        limit: Math.floor(limitBytes / BYTES_PER_MB),
      }),
    );
    this.name = "AttachmentsTooLargeError";
  }
}

export function measureEncodedAttachments(
  images: readonly { data: string; mimeType: string }[],
): number {
  let bytes = 0;
  // Base64 and MIME types are ASCII, so string length equals UTF-8 bytes.
  for (const image of images)
    bytes += image.data.length + image.mimeType.length + PER_IMAGE_OVERHEAD_BYTES;
  return bytes;
}

/** Throws before send when the pictures cannot fit one message on the wire. */
export function assertAttachmentsFitMessage(
  images: readonly { data: string; mimeType: string }[],
  limitBytes = MAX_MESSAGE_ATTACHMENT_BYTES,
): void {
  const bytes = measureEncodedAttachments(images);
  if (bytes > limitBytes) throw new AttachmentsTooLargeError(bytes, limitBytes);
}
