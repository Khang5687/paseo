import type { ComposerAttachment } from "@/attachments/types";
import type { AttachmentMetadata } from "@/attachments/types";
import { retainAttachmentForGarbageCollection } from "@/attachments/gc-retention";
import type {
  ActiveTurnBehavior,
  AgentQueuedMessagePayload,
  AgentQueuedMessageSummaryPayload,
} from "@getpaseo/protocol/messages";
import {
  splitComposerAttachmentsForSubmit,
  type ComposerAttachmentSubmitFormat,
} from "@/composer/attachments/submit";
import { createUserMessage, type StreamItem, type UserMessageItem } from "@/types/stream";
import type {
  AttachmentPersister,
  MessageSubmissionWriter,
  QueuedComposerMessage,
  QueueWriter,
} from "./actions";

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
  clearQueuedAgentMessages: (input: { agentId: string }) => Promise<number>;
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

/**
 * Call before the composer clears: the queued images lose their draft reference then, and stay
 * retained against attachment cleanup until the mirror entry references them.
 */
export async function queueMessageOnDaemon(
  input: QueueMessageOnDaemonInput,
): Promise<AgentQueuedMessageSummaryPayload> {
  const wirePayload = splitComposerAttachmentsForSubmit(input.attachments, {
    format: input.attachmentSubmitFormat,
  });
  const releaseImages = wirePayload.images.map((image) =>
    retainAttachmentForGarbageCollection(image.id),
  );
  try {
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
  } finally {
    for (const release of releaseImages) release();
  }
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
  /** The active turn the row joins when steering; omitted for interrupt. */
  activeTurnId?: string;
  localMirror: QueueWriter;
  /** The daemon's summary of the entry, used for the row when another client queued it. */
  summary: Pick<AgentQueuedMessageSummaryPayload, "text"> | null;
  attachmentSubmitFormat?: ComposerAttachmentSubmitFormat;
  submission: MessageSubmissionWriter;
}

/**
 * Same contract as a composer send: the row appears before the RPC resolves,
 * keyed by the entry id, and the daemon records its canonical user_message
 * under that same id so the two reconcile. A failed RPC removes the row.
 */
export async function sendQueuedMessageNowOnDaemon(
  input: SendQueuedMessageNowOnDaemonInput,
): Promise<void> {
  const mirrored =
    input.localMirror.read(input.agentId).find((item) => item.id === input.messageId) ?? null;
  const wirePayload = splitComposerAttachmentsForSubmit(mirrored?.attachments ?? [], {
    format: input.attachmentSubmitFormat,
  });
  const text = mirrored?.text ?? input.summary?.text ?? "";
  input.submission.begin(
    input.agentId,
    createUserMessage({
      clientMessageId: input.messageId,
      text,
      timestamp: new Date(),
      images: wirePayload.images,
      attachments: wirePayload.attachments,
      ...(input.activeTurnBehavior === "steer" && input.activeTurnId
        ? { turnId: input.activeTurnId }
        : {}),
    }),
  );
  try {
    await input.client.sendQueuedAgentMessageNow({
      agentId: input.agentId,
      messageId: input.messageId,
      activeTurnBehavior: input.activeTurnBehavior,
    });
  } catch (error) {
    input.submission.reject(input.agentId, input.messageId);
    throw error;
  }
  input.submission.accept(input.agentId, input.messageId);
  takeFromLocalMirror(input.localMirror, input.agentId, input.messageId);
}

export interface DeleteQueuedMessageOnDaemonInput {
  client: DaemonQueueClient;
  agentId: string;
  messageId: string;
  localMirror: QueueWriter;
}

export async function deleteQueuedMessageOnDaemon(
  input: DeleteQueuedMessageOnDaemonInput,
): Promise<void> {
  await input.client.removeQueuedAgentMessage({
    agentId: input.agentId,
    messageId: input.messageId,
  });
  takeFromLocalMirror(input.localMirror, input.agentId, input.messageId);
}

export interface ClearQueueOnDaemonInput {
  client: DaemonQueueClient;
  agentId: string;
  localMirror: QueueWriter;
}

export async function clearQueueOnDaemon(input: ClearQueueOnDaemonInput): Promise<void> {
  await input.client.clearQueuedAgentMessages({ agentId: input.agentId });
  if (input.localMirror.read(input.agentId).length === 0) return;
  input.localMirror.write((prev) => {
    const next = new Map(prev);
    next.delete(input.agentId);
    return next;
  });
}

interface QueueEntry {
  id: string;
}

export interface QueueMove {
  messageId: string;
  toIndex: number;
}

/** Same semantics as the daemon's move: take the entry out, insert at `toIndex` of what remains. */
export function moveQueueEntry<T extends QueueEntry>(items: readonly T[], move: QueueMove): T[] {
  const fromIndex = items.findIndex((item) => item.id === move.messageId);
  if (fromIndex === -1) return [...items];
  const next = items.filter((_, index) => index !== fromIndex);
  next.splice(Math.min(move.toIndex, next.length), 0, items[fromIndex]);
  return next;
}

/**
 * Recovers the single move a drag produced. `after` is a permutation of
 * `before` that moved one entry; returns null when the order did not change.
 */
export function findQueueMove<T extends QueueEntry>(
  before: readonly T[],
  after: readonly T[],
): QueueMove | null {
  let first = 0;
  while (first < before.length && before[first].id === after[first].id) first++;
  if (first === before.length) return null;
  let last = before.length - 1;
  while (last > first && before[last].id === after[last].id) last--;
  if (after[first].id === before[last].id) {
    return { messageId: before[last].id, toIndex: first };
  }
  return { messageId: before[first].id, toIndex: last };
}

/**
 * A reorder shown before the daemon confirms it. It holds only while the daemon
 * still lists the order it was applied over; any newer daemon order wins.
 */
export interface OptimisticQueueOrder {
  baselineIds: readonly string[];
  ids: readonly string[];
}

export function createOptimisticQueueOrder(
  daemonQueue: readonly QueueEntry[],
  reordered: readonly QueueEntry[],
): OptimisticQueueOrder {
  return {
    baselineIds: daemonQueue.map((item) => item.id),
    ids: reordered.map((item) => item.id),
  };
}

export function isOptimisticQueueOrderCurrent(
  daemonQueue: readonly QueueEntry[],
  order: OptimisticQueueOrder,
): boolean {
  return (
    daemonQueue.length === order.baselineIds.length &&
    daemonQueue.every((item, index) => item.id === order.baselineIds[index])
  );
}

/**
 * Entries the reorder did not list (hidden while their send-now was in flight)
 * keep their daemon order after the reordered ones.
 */
export function applyOptimisticQueueOrder<T extends QueueEntry>(
  daemonQueue: readonly T[],
  order: OptimisticQueueOrder | null,
): readonly T[] {
  if (!order || !isOptimisticQueueOrderCurrent(daemonQueue, order)) return daemonQueue;
  const rank = new Map(order.ids.map((id, index) => [id, index]));
  const unranked = order.ids.length;
  return [...daemonQueue].sort(
    (left, right) => (rank.get(left.id) ?? unranked) - (rank.get(right.id) ?? unranked),
  );
}

/**
 * How long the mirror keeps an entry the daemon dropped without a matching timeline row. Past
 * it, the entry was removed on another client rather than dispatched.
 */
export const DISPATCH_ECHO_WAIT_MS = 60_000;

export interface ReconcileLocalMirrorInput {
  localMirror: QueueWriter;
  agentId: string;
  daemonQueue: readonly AgentQueuedMessageSummaryPayload[];
  /** Reads the agent's loaded timeline rows; called only when an entry is settling. */
  readTimeline: () => readonly StreamItem[];
  attachmentSubmitFormat?: ComposerAttachmentSubmitFormat;
  /** Puts a dispatched entry's local images and attachments on its timeline row. */
  handoff: (message: UserMessageItem) => void;
  nowMs: number;
}

/**
 * Settles mirror entries the daemon no longer lists. The daemon records a dispatched entry's
 * user message under the entry id but never echoes its images, so the row only shows them if
 * this client hands its copy over. The queue snapshot drops the entry before that row arrives:
 * keep the entry (and its images' cleanup reference) until the row shows up, or until
 * `DISPATCH_ECHO_WAIT_MS` says it was removed elsewhere. Call when the agent's queue summary or
 * timeline changes.
 */
export function reconcileLocalMirror(input: ReconcileLocalMirrorInput): void {
  const current = input.localMirror.read(input.agentId);
  if (current.length === 0) return;
  const liveIds = new Set(input.daemonQueue.map((item) => item.id));
  const settling = current.filter((entry) => !liveIds.has(entry.id));
  if (settling.length === 0) return;
  const settlingIds = new Set(settling.map((entry) => entry.id));
  const echoes = new Map<string, UserMessageItem>();
  for (const item of input.readTimeline()) {
    if (
      item.kind === "user_message" &&
      item.clientMessageId &&
      settlingIds.has(item.clientMessageId)
    ) {
      echoes.set(item.clientMessageId, item);
    }
  }

  let changed = false;
  const kept: QueuedComposerMessage[] = [];
  const handoffs: UserMessageItem[] = [];
  for (const entry of current) {
    if (liveIds.has(entry.id)) {
      kept.push(entry);
      continue;
    }
    const echo = echoes.get(entry.id);
    if (echo) {
      const wire = splitComposerAttachmentsForSubmit(entry.attachments, {
        format: input.attachmentSubmitFormat,
      });
      if (wire.images.length > 0 || wire.attachments.length > 0) {
        handoffs.push(
          createUserMessage({ ...echo, images: wire.images, attachments: wire.attachments }),
        );
      }
      changed = true;
      continue;
    }
    if (entry.leftDaemonQueueAt === undefined) {
      kept.push({ ...entry, leftDaemonQueueAt: input.nowMs });
      changed = true;
      continue;
    }
    if (input.nowMs - entry.leftDaemonQueueAt >= DISPATCH_ECHO_WAIT_MS) {
      changed = true;
      continue;
    }
    kept.push(entry);
  }
  if (!changed) return;
  // Settle the mirror before handing off: the handoff writes the store the caller reconciles
  // from, and a re-entrant reconcile must not find the entry again.
  input.localMirror.write((prev) => {
    const next = new Map(prev);
    if (kept.length === 0) {
      next.delete(input.agentId);
    } else {
      next.set(input.agentId, kept);
    }
    return next;
  });
  for (const message of handoffs) input.handoff(message);
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
