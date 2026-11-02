import type {
  AgentDraft,
  AgentDraftAttachment,
  AgentDraftSnapshotSummary,
  AgentDraftState,
  SessionOutboundMessage,
} from "@getpaseo/protocol/messages";
import type { AttachmentMetadata, UserComposerAttachment } from "@/attachments/types";
import { UserComposerAttachmentSchema } from "@/stores/draft-store/state";
import type { DraftInput, DraftLifecycleState } from "@/stores/draft-store";
import { z } from "zod";

// At most ~3 pushes a second while typing.
export const DRAFT_PUSH_INTERVAL_MS = 350;
// Remote text waits while the local user typed this recently.
export const DRAFT_TYPING_GUARD_MS = 2000;
// The daemon refuses to read back larger draft uploads.
const MAX_SYNCED_IMAGE_BYTES = 20 * 1024 * 1024;
const RECENT_PUSH_LIMIT = 8;

const WireImageSchema = z.object({ mimeType: z.string(), fileName: z.string().nullable() });

interface DraftSubscriptionObserver {
  snapshot(response: { state: AgentDraftState | null }): void;
  update(message: SessionOutboundMessage): void;
  error?(error: unknown): void;
}

export interface AgentDraftSubscription {
  subscribe(observer: DraftSubscriptionObserver): () => void;
  release(): Promise<void>;
}

export interface AgentDraftSyncClient {
  observeAgentDraft(agentId: string): AgentDraftSubscription;
  setAgentDraft(input: {
    agentId: string;
    text: string;
    attachments: AgentDraftAttachment[];
    updatedAt: number;
    baseRevision: number | null;
    reason?: "edit" | "sent";
  }): Promise<{ accepted: boolean; state: AgentDraftState | null }>;
  restoreAgentDraft(
    agentId: string,
    snapshotId: string,
  ): Promise<{ state: AgentDraftState | null }>;
  getAgentDraftUpload(agentId: string, uploadId: string): Promise<{ data: string }>;
  uploadFile(input: {
    fileName: string;
    mimeType: string;
    bytes: Uint8Array;
  }): Promise<{ file: { id: string } | null; error: string | null }>;
}

export interface LocalDraft {
  input: DraftInput;
  lifecycle: DraftLifecycleState;
  version: number;
  updatedAt: number;
  synced: boolean;
}

/** The device's copy of the draft (the draft store) and the editor showing it. */
export interface AgentDraftSyncLocal {
  read(): LocalDraft | null;
  subscribe(listener: () => void): () => void;
  /** Stores the daemon's draft as already synced and shows its text in the editor. */
  apply(input: DraftInput, updatedAt: number): void;
  markSynced(version: number): void;
  setImageUploadId(imageId: string, uploadId: string): void;
}

export interface AgentDraftSyncMedia {
  readImageBytes(metadata: AttachmentMetadata): Promise<Uint8Array>;
  saveImage(input: {
    base64: string;
    mimeType: string;
    fileName: string | null;
  }): Promise<AttachmentMetadata>;
}

export interface AgentDraftSyncOptions {
  agentId: string;
  client: AgentDraftSyncClient;
  local: AgentDraftSyncLocal;
  media: AgentDraftSyncMedia;
  onHistory: (history: AgentDraftSnapshotSummary[]) => void;
  now?: () => number;
}

const EMPTY_INPUT: DraftInput = { text: "", attachments: [] };

function contentOf(draft: LocalDraft | null): DraftInput {
  return draft?.lifecycle === "active" ? draft.input : EMPTY_INPUT;
}

/**
 * Images sync once their bytes live on the daemon; until then they stay on this device.
 * Image metadata names device-local storage, so only the upload and its type travel.
 */
export function toWireAttachments(attachments: UserComposerAttachment[]): AgentDraftAttachment[] {
  return attachments.flatMap((attachment): AgentDraftAttachment[] => {
    if (attachment.kind === "image") {
      const { uploadId, mimeType, fileName } = attachment.metadata;
      return uploadId
        ? [{ kind: "image", uploadId, value: { fileName: fileName ?? null, mimeType } }]
        : [];
    }
    const value = sortKeysDeep(attachment);
    if (attachment.kind === "file") {
      return [{ kind: "file", uploadId: attachment.attachment.id, value }];
    }
    return [{ kind: attachment.kind, value }];
  });
}

/** Devices rebuild attachments in different key orders; the wire form sorts them. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeysDeep((value as Record<string, unknown>)[key])]),
  );
}

export function draftContentKey(input: {
  text: string;
  attachments: AgentDraftAttachment[];
}): string {
  return JSON.stringify([
    input.text,
    // Image metadata names device-local storage, so images compare by upload.
    input.attachments.map((attachment) =>
      attachment.kind === "image"
        ? `image:${attachment.uploadId}`
        : `${attachment.kind}:${JSON.stringify(sortKeysDeep(attachment.value))}`,
    ),
  ]);
}

function localContentKey(input: DraftInput): string {
  return draftContentKey({ text: input.text, attachments: toWireAttachments(input.attachments) });
}

function isPendingImage(
  attachment: UserComposerAttachment,
): attachment is Extract<UserComposerAttachment, { kind: "image" }> {
  return attachment.kind === "image" && !attachment.metadata.uploadId;
}

/**
 * Keeps one agent chat draft in step with the daemon while the chat is on screen.
 * Last write wins; local typing holds off remote text for a moment; offline edits
 * push on reconnect and the daemon decides by `updatedAt`.
 */
export class AgentDraftSyncController {
  private readonly agentId: string;
  private readonly client: AgentDraftSyncClient;
  private readonly local: AgentDraftSyncLocal;
  private readonly media: AgentDraftSyncMedia;
  private readonly onHistory: (history: AgentDraftSnapshotSummary[]) => void;
  private readonly now: () => number;

  private subscription: AgentDraftSubscription | null = null;
  private detachObserver: (() => void) | null = null;
  private detachLocal: (() => void) | null = null;
  private stopped = false;
  private ready = false;

  private lastSeenRevision: number | null = null;
  private observedVersion: number | null = null;
  private lastLocalEditAt = 0;
  private lastPushAt = 0;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private pushInFlight = false;
  private pushAgain = false;
  private readonly recentPushKeys: string[] = [];

  private deferredRemote: AgentDraft | null = null;
  private guardTimer: ReturnType<typeof setTimeout> | null = null;
  private applyChain: Promise<void> = Promise.resolve();

  private readonly uploading = new Set<string>();
  private readonly failedUploads = new Set<string>();
  private readonly fetchedImages = new Map<string, AttachmentMetadata>();

  constructor(options: AgentDraftSyncOptions) {
    this.agentId = options.agentId;
    this.client = options.client;
    this.local = options.local;
    this.media = options.media;
    this.onHistory = options.onHistory;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    this.observedVersion = this.local.read()?.version ?? null;
    this.detachLocal = this.local.subscribe(() => this.handleLocalChange());
    const subscription = this.client.observeAgentDraft(this.agentId);
    this.subscription = subscription;
    this.detachObserver = subscription.subscribe({
      // Also fires after every reconnect, which is when offline edits go out.
      snapshot: (response) => this.reconcile(response.state),
      update: (message) => {
        if (message.type !== "agent.draft.update" || message.payload.agentId !== this.agentId) {
          return;
        }
        if (message.payload.history) this.onHistory(message.payload.history);
        if (message.payload.draft) this.receiveRemote(message.payload.draft);
      },
      error: (error) => console.warn("[DraftSync] Draft subscription failed", error),
    });
    this.ensureImageUploads();
  }

  /** Stops all work. A pending push goes out now so other devices see the last keystrokes. */
  stop(): void {
    if (this.stopped) return;
    const hadPendingPush = this.pushTimer !== null || this.pushAgain;
    this.clearTimers();
    this.detachLocal?.();
    this.detachObserver?.();
    void this.subscription
      ?.release()
      .catch((error) => console.warn("[DraftSync] Failed to release draft subscription", error));
    if (hadPendingPush && this.ready) void this.push();
    this.stopped = true;
  }

  async restore(snapshotId: string): Promise<void> {
    const result = await this.client.restoreAgentDraft(this.agentId, snapshotId);
    if (!result.state) return;
    this.onHistory(result.state.history);
    if (result.state.draft) this.receiveRemote(result.state.draft, { force: true });
  }

  private clearTimers(): void {
    clearTimeout(this.pushTimer ?? undefined);
    clearTimeout(this.guardTimer ?? undefined);
    this.pushTimer = null;
    this.guardTimer = null;
  }

  private handleLocalChange(): void {
    const draft = this.local.read();
    const version = draft?.version ?? null;
    if (version === this.observedVersion) return;
    this.observedVersion = version;
    if (!draft || draft.synced) return;
    this.lastLocalEditAt = this.now();
    this.schedulePush();
    this.ensureImageUploads();
  }

  private reconcile(state: AgentDraftState | null): void {
    if (this.stopped || !state) return;
    this.ready = true;
    this.onHistory(state.history);
    const local = this.local.read();
    const remote = state.draft;
    const localKey = localContentKey(contentOf(local));
    const remoteKey = remote ? draftContentKey(remote) : localContentKey(EMPTY_INPUT);
    if (localKey === remoteKey) {
      if (remote) this.lastSeenRevision = remote.revision;
      if (local) this.local.markSynced(local.version);
      return;
    }
    if (local && !local.synced) {
      // Edits the daemon has not seen. Keep the last revision this device saw: if the
      // daemon moved on meanwhile, the push competes on updatedAt and the loser is kept
      // in the restore history.
      this.schedulePush();
      return;
    }
    if (remote) this.receiveRemote(remote);
  }

  private receiveRemote(remote: AgentDraft, options?: { force?: boolean }): void {
    this.applyChain = this.applyChain
      .then(() => this.applyRemote(remote, options?.force ?? false))
      .catch((error) => console.warn("[DraftSync] Failed to apply remote draft", error));
  }

  private async applyRemote(remote: AgentDraft, force: boolean): Promise<void> {
    if (this.stopped) return;
    const local = this.local.read();
    if (this.settleRemote(remote, local, force)) return;
    const attachments = await this.toLocalAttachments(remote.attachments, contentOf(local));
    if (this.stopped) return;
    const current = this.local.read();
    if (!force && current?.version !== local?.version) {
      // The user typed while images downloaded; try again once they pause.
      this.defer(remote);
      return;
    }
    // Images still uploading from this device stay in its draft.
    const pending = contentOf(current).attachments.filter(isPendingImage);
    this.seeRevision(remote.revision);
    this.deferredRemote = null;
    this.local.apply(
      { text: remote.text, attachments: [...attachments, ...pending] },
      remote.updatedAt,
    );
    this.observedVersion = this.local.read()?.version ?? null;
    if (pending.length > 0) this.schedulePush();
  }

  /** Handles a remote draft that needs no local write. Returns false when it must be applied. */
  private settleRemote(remote: AgentDraft, local: LocalDraft | null, force: boolean): boolean {
    if (!force && this.lastSeenRevision !== null && remote.revision <= this.lastSeenRevision) {
      return true;
    }
    const remoteKey = draftContentKey(remote);
    if (remoteKey === localContentKey(contentOf(local))) {
      this.seeRevision(remote.revision);
      if (local) this.local.markSynced(local.version);
      return true;
    }
    if (force) return false;
    if (this.recentPushKeys.includes(remoteKey)) {
      // Our own earlier push coming back after the user typed on.
      this.seeRevision(remote.revision);
      return true;
    }
    if (this.now() - this.lastLocalEditAt < DRAFT_TYPING_GUARD_MS) {
      this.defer(remote);
      return true;
    }
    return false;
  }

  private seeRevision(revision: number): void {
    this.lastSeenRevision = Math.max(this.lastSeenRevision ?? 0, revision);
  }

  private defer(remote: AgentDraft): void {
    if (!this.deferredRemote || remote.revision >= this.deferredRemote.revision) {
      this.deferredRemote = remote;
    }
    if (this.guardTimer) return;
    const delay = Math.max(0, this.lastLocalEditAt + DRAFT_TYPING_GUARD_MS - this.now());
    this.guardTimer = setTimeout(() => {
      this.guardTimer = null;
      const deferred = this.deferredRemote;
      if (deferred) this.receiveRemote(deferred);
    }, delay);
  }

  private async toLocalAttachments(
    wire: AgentDraftAttachment[],
    local: DraftInput,
  ): Promise<UserComposerAttachment[]> {
    const localImages = new Map<string, AttachmentMetadata>();
    for (const attachment of local.attachments) {
      if (attachment.kind === "image" && attachment.metadata.uploadId) {
        localImages.set(attachment.metadata.uploadId, attachment.metadata);
      }
    }
    const result: UserComposerAttachment[] = [];
    for (const entry of wire) {
      if (entry.kind === "image") {
        const image = WireImageSchema.safeParse(entry.value);
        if (!entry.uploadId || !image.success) continue;
        const metadata =
          localImages.get(entry.uploadId) ?? (await this.fetchImage(entry.uploadId, image.data));
        if (metadata) result.push({ kind: "image", metadata });
        continue;
      }
      const parsed = UserComposerAttachmentSchema.safeParse(entry.value);
      if (parsed.success && parsed.data.kind !== "image") result.push(parsed.data);
    }
    return result;
  }

  private async fetchImage(
    uploadId: string,
    image: z.infer<typeof WireImageSchema>,
  ): Promise<AttachmentMetadata | null> {
    const cached = this.fetchedImages.get(uploadId);
    if (cached) return cached;
    try {
      const upload = await this.client.getAgentDraftUpload(this.agentId, uploadId);
      const saved = await this.media.saveImage({
        base64: upload.data,
        mimeType: image.mimeType,
        fileName: image.fileName,
      });
      const metadata = { ...saved, uploadId };
      this.fetchedImages.set(uploadId, metadata);
      return metadata;
    } catch (error) {
      console.warn("[DraftSync] Failed to fetch a draft image", error);
      return null;
    }
  }

  private schedulePush(): void {
    if (this.stopped) return;
    if (this.pushInFlight) {
      this.pushAgain = true;
      return;
    }
    if (this.pushTimer) return;
    const delay = Math.max(0, this.lastPushAt + DRAFT_PUSH_INTERVAL_MS - this.now());
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      void this.push();
    }, delay);
  }

  private async push(): Promise<void> {
    if (!this.ready) return;
    const local = this.local.read();
    if (!local || local.synced) return;
    const input = contentOf(local);
    const attachments = toWireAttachments(input.attachments);
    const key = draftContentKey({ text: input.text, attachments });
    this.recentPushKeys.push(key);
    if (this.recentPushKeys.length > RECENT_PUSH_LIMIT) this.recentPushKeys.shift();
    this.pushInFlight = true;
    this.lastPushAt = this.now();
    try {
      const result = await this.client.setAgentDraft({
        agentId: this.agentId,
        text: input.text,
        attachments,
        updatedAt: local.updatedAt,
        baseRevision: this.lastSeenRevision,
        reason: local.lifecycle === "sent" ? "sent" : "edit",
      });
      const state = result.state;
      if (state) this.onHistory(state.history);
      if (result.accepted && state?.draft) {
        this.seeRevision(state.draft.revision);
        if (!input.attachments.some(isPendingImage)) this.local.markSynced(local.version);
      } else if (state?.draft) {
        // A newer draft won; this one went to the restore history.
        this.receiveRemote(state.draft);
      }
    } catch (error) {
      // Offline or the host refused. The draft stays unsynced and goes out on the next snapshot.
      console.warn("[DraftSync] Failed to push draft", error);
    } finally {
      this.pushInFlight = false;
      if (this.pushAgain) {
        this.pushAgain = false;
        this.schedulePush();
      }
    }
  }

  private ensureImageUploads(): void {
    if (this.stopped) return;
    for (const attachment of contentOf(this.local.read()).attachments) {
      if (!isPendingImage(attachment)) continue;
      const { metadata } = attachment;
      if (this.uploading.has(metadata.id) || this.failedUploads.has(metadata.id)) continue;
      if ((metadata.byteSize ?? 0) > MAX_SYNCED_IMAGE_BYTES) continue;
      this.uploading.add(metadata.id);
      void this.uploadImage(metadata).finally(() => this.uploading.delete(metadata.id));
    }
  }

  private async uploadImage(metadata: AttachmentMetadata): Promise<void> {
    try {
      const bytes = await this.media.readImageBytes(metadata);
      if (bytes.byteLength > MAX_SYNCED_IMAGE_BYTES) {
        this.failedUploads.add(metadata.id);
        return;
      }
      const response = await this.client.uploadFile({
        fileName: metadata.fileName ?? `image-${metadata.id}`,
        mimeType: metadata.mimeType,
        bytes,
      });
      if (!response.file) throw new Error(response.error ?? "Upload failed.");
      if (this.stopped) return;
      this.local.setImageUploadId(metadata.id, response.file.id);
    } catch (error) {
      this.failedUploads.add(metadata.id);
      console.warn("[DraftSync] Failed to upload a draft image", error);
    }
  }
}
