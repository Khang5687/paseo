import type { ComposerAttachment } from "@/attachments/types";
import type { AttachmentMetadata } from "@/attachments/types";
import type {
  ActiveTurnBehavior,
  AgentQueuedMessagePayload,
  AgentQueuedMessageSummaryPayload,
} from "@getpaseo/protocol/messages";
import {
  splitComposerAttachmentsForSubmit,
  type ComposerAttachmentSubmitFormat,
} from "@/composer/attachments/submit";
import type { AttachmentPersister, QueuedComposerMessage, QueueWriter } from "./actions";

/**
 * Daemon-owned queue. The host stores and dispatches queued messages, so every
 * client sees the same list. Gate on `serverInfo.features.messageQueue`; the
 * client-local path in `./actions.ts` is the fallback for older hosts.
 */
export interface DaemonQueueClient {
  addQueuedAgentMessage: (input: {
    agentId: string;
    text: string;
    images?: Array<{ data: string; mimeType: string }>;
    attachments?: AgentQueuedMessagePayload["attachments"];
  }) => Promise<AgentQueuedMessageSummaryPayload>;
  removeQueuedAgentMessage: (input: {
    agentId: string;
    messageId: string;
  }) => Promise<AgentQueuedMessagePayload>;
  sendQueuedAgentMessageNow: (input: {
    agentId: string;
    messageId: string;
    activeTurnBehavior?: ActiveTurnBehavior;
  }) => Promise<void>;
}

export interface QueueMessageOnDaemonInput {
  client: DaemonQueueClient;
  agentId: string;
  text: string;
  attachments: ComposerAttachment[];
  attachmentSubmitFormat?: ComposerAttachmentSubmitFormat;
  encodeImages: (
    images: AttachmentMetadata[],
  ) => Promise<Array<{ data: string; mimeType: string }> | undefined>;
  /**
   * Local mirror of entries queued from this client, keyed by the daemon's id.
   * Lets a same-client edit restore the original composer attachments
   * losslessly; the daemon only holds the encoded wire form.
   */
  localMirror: QueueWriter;
}

export async function queueMessageOnDaemon(
  input: QueueMessageOnDaemonInput,
): Promise<AgentQueuedMessageSummaryPayload> {
  const wirePayload = splitComposerAttachmentsForSubmit(input.attachments, {
    format: input.attachmentSubmitFormat,
  });
  const imagesData = await input.encodeImages(wirePayload.images);
  const summary = await input.client.addQueuedAgentMessage({
    agentId: input.agentId,
    text: input.text,
    images: imagesData ?? [],
    attachments: wirePayload.attachments,
  });
  input.localMirror.write((prev) => {
    const next = new Map(prev);
    const existing = next.get(input.agentId) ?? [];
    next.set(input.agentId, [
      ...existing,
      { id: summary.id, text: input.text, attachments: input.attachments },
    ]);
    return next;
  });
  return summary;
}

export interface RestoreQueuedMessageFromDaemonInput {
  client: DaemonQueueClient;
  agentId: string;
  messageId: string;
  localMirror: QueueWriter;
  persister: Pick<AttachmentPersister, "persistFromDataUrl">;
}

/**
 * Pops the entry off the daemon and returns what the composer can re-edit.
 * A same-client entry restores exactly. A cross-client entry rebuilds images
 * and uploaded files from the wire payload; attachment kinds that only exist
 * as a composer reference (forge items, workspace files, plugin resources)
 * cannot be rebuilt from their agent form and are dropped.
 */
export async function restoreQueuedMessageFromDaemon(
  input: RestoreQueuedMessageFromDaemonInput,
): Promise<QueuedComposerMessage> {
  const removed = await input.client.removeQueuedAgentMessage({
    agentId: input.agentId,
    messageId: input.messageId,
  });
  const mirrored = takeFromLocalMirror(input.localMirror, input.agentId, input.messageId);
  if (mirrored) {
    return { id: removed.id, text: removed.text, attachments: mirrored.attachments };
  }
  const attachments: ComposerAttachment[] = [];
  for (const image of removed.images) {
    const metadata = await input.persister.persistFromDataUrl({
      dataUrl: `data:${image.mimeType};base64,${image.data}`,
      mimeType: image.mimeType,
      fileName: null,
    });
    attachments.push({ kind: "image", metadata });
  }
  for (const attachment of removed.attachments) {
    if (attachment.type === "uploaded_file") {
      attachments.push({ kind: "file", attachment });
    }
  }
  return { id: removed.id, text: removed.text, attachments };
}

export interface SendQueuedMessageNowOnDaemonInput {
  client: DaemonQueueClient;
  agentId: string;
  messageId: string;
  activeTurnBehavior: ActiveTurnBehavior;
  localMirror: QueueWriter;
}

export async function sendQueuedMessageNowOnDaemon(
  input: SendQueuedMessageNowOnDaemonInput,
): Promise<void> {
  await input.client.sendQueuedAgentMessageNow({
    agentId: input.agentId,
    messageId: input.messageId,
    activeTurnBehavior: input.activeTurnBehavior,
  });
  takeFromLocalMirror(input.localMirror, input.agentId, input.messageId);
}

/**
 * Drops mirror entries the daemon no longer lists (dispatched, or removed by
 * another client). Call whenever the agent's `queuedMessages` summary changes.
 */
export function pruneLocalMirror(
  localMirror: QueueWriter,
  agentId: string,
  daemonQueue: readonly AgentQueuedMessageSummaryPayload[],
): void {
  const liveIds = new Set(daemonQueue.map((item) => item.id));
  const current = localMirror.read(agentId);
  if (current.every((item) => liveIds.has(item.id))) return;
  localMirror.write((prev) => {
    const next = new Map(prev);
    const kept = (next.get(agentId) ?? []).filter((item) => liveIds.has(item.id));
    if (kept.length === 0) {
      next.delete(agentId);
    } else {
      next.set(agentId, kept);
    }
    return next;
  });
}

function takeFromLocalMirror(
  localMirror: QueueWriter,
  agentId: string,
  messageId: string,
): QueuedComposerMessage | null {
  const found = localMirror.read(agentId).find((item) => item.id === messageId) ?? null;
  if (found) {
    localMirror.write((prev) => {
      const next = new Map(prev);
      const kept = (next.get(agentId) ?? []).filter((item) => item.id !== messageId);
      if (kept.length === 0) {
        next.delete(agentId);
      } else {
        next.set(agentId, kept);
      }
      return next;
    });
  }
  return found;
}
