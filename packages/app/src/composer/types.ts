import type { ActiveTurnBehavior } from "@getpaseo/protocol/messages";
import type { AttachmentMetadata, ComposerAttachment } from "@/attachments/types";

export type ImageAttachment = AttachmentMetadata;

export interface MessagePayload {
  text: string;
  attachments: ComposerAttachment[];
  cwd: string;
  forceSend?: boolean;
  /** How a send lands on a running turn; the send action that produced it decides. */
  activeTurnBehavior?: ActiveTurnBehavior;
}

/**
 * Text the draft owner hands the editor. `hydrated` is the owner's answer to a mount:
 * the draft's text as persisted or still pending from the editor that unmounted.
 * `remote` is text another device wrote; the editor keeps its caret where it was.
 */
export interface TextReplacement {
  kind: "initial" | "hydrated" | "replace" | "remote";
  key: string;
  text: string;
}
