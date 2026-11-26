import type { AttachmentMetadata } from "@/attachments/types";

export interface EncodedImage {
  data: string;
  mimeType: string;
}

export interface DownscaleForSendInput {
  /** Kept as is when it is marked `sendOriginal`. */
  attachment: AttachmentMetadata;
  /** Reads the stored picture as base64, the payload sent when it is kept as is. */
  readBase64: () => Promise<string>;
}
