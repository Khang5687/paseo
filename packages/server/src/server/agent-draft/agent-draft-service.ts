import { randomUUID } from "node:crypto";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type pino from "pino";
import type {
  AgentDraft,
  AgentDraftAttachment,
  AgentDraftSnapshotSummary,
  AgentDraftState,
} from "@getpaseo/protocol/messages";
import type {
  AgentStorage,
  StoredAgentDraftFields,
  StoredAgentDraftSnapshot,
} from "../agent/agent-storage.js";

export const DEFAULT_DRAFT_HISTORY_RETENTION_DAYS = 7;
const MAX_DRAFT_SNAPSHOTS = 10;
// Shrinking a short draft is ordinary typing, not a loss worth a snapshot.
const MIN_SHRINK_SNAPSHOT_CHARS = 20;
const PREVIEW_CHARS = 80;
const DAY_MS = 24 * 60 * 60 * 1000;
// Base64 grows bytes by a third; this keeps a response under the relay frame cap.
const MAX_UPLOAD_READ_BYTES = 20 * 1024 * 1024;
const UPLOAD_ID_PATTERN = /^upload_[0-9a-f-]{36}$/i;

export interface DraftSetInput {
  text: string;
  attachments: AgentDraftAttachment[];
  updatedAt: number;
  baseRevision: number | null;
  clientId: string;
}

export interface DraftPolicy {
  now: number;
  retentionMs: number;
}

interface DraftTransition {
  fields: StoredAgentDraftFields;
  accepted: boolean;
}

export interface AgentDraftChange {
  agentId: string;
  draft: AgentDraft | null;
  // Undefined when the history did not change.
  history?: AgentDraftSnapshotSummary[];
}

type DraftListener = (change: AgentDraftChange) => void;

interface DraftContent {
  text: string;
  attachments: AgentDraftAttachment[];
}

function isEmpty(content: DraftContent): boolean {
  return content.text.length === 0 && content.attachments.length === 0;
}

function sameContent(a: DraftContent, b: DraftContent): boolean {
  return a.text === b.text && JSON.stringify(a.attachments) === JSON.stringify(b.attachments);
}

function pruneHistory(
  history: StoredAgentDraftSnapshot[] | undefined,
  policy: DraftPolicy,
): StoredAgentDraftSnapshot[] {
  const cutoff = policy.now - policy.retentionMs;
  return (history ?? [])
    .filter((snapshot) => snapshot.createdAt > cutoff)
    .slice(0, MAX_DRAFT_SNAPSHOTS);
}

/** Newest first. An identical snapshot moves to the front instead of repeating. */
function pushSnapshot(
  history: StoredAgentDraftSnapshot[],
  content: { text: string; attachments: AgentDraftAttachment[] },
  now: number,
): StoredAgentDraftSnapshot[] {
  const rest = history.filter((snapshot) => !sameContent(snapshot, content));
  return [
    { id: randomUUID(), createdAt: now, text: content.text, attachments: content.attachments },
    ...rest,
  ].slice(0, MAX_DRAFT_SNAPSHOTS);
}

function uploadIdsOf(attachments: AgentDraftAttachment[]): string[] {
  return attachments.flatMap((attachment) => (attachment.uploadId ? [attachment.uploadId] : []));
}

function referencedUploadIds(fields: StoredAgentDraftFields): Set<string> {
  const ids = new Set<string>(uploadIdsOf(fields.draft?.attachments ?? []));
  for (const snapshot of fields.draftHistory ?? []) {
    for (const id of uploadIdsOf(snapshot.attachments)) ids.add(id);
  }
  return ids;
}

/**
 * Image uploads the draft or its history referenced before and no longer do. Draft sync makes
 * those uploads only so another device can show the images; a send carries image bytes itself.
 * File uploads are never released here: the message names their path, and the composer clears
 * its attachments while that message can still be on its way to the agent.
 */
export function releasedUploadIds(
  before: StoredAgentDraftFields,
  after: StoredAgentDraftFields,
): string[] {
  const still = referencedUploadIds(after);
  const images = new Set<string>();
  for (const attachments of [
    before.draft?.attachments ?? [],
    ...(before.draftHistory ?? []).map((snapshot) => snapshot.attachments),
  ]) {
    for (const attachment of attachments) {
      if (attachment.kind === "image" && attachment.uploadId) images.add(attachment.uploadId);
    }
  }
  return [...images].filter((id) => !still.has(id));
}

/** True when replacing `current` with `next` throws away text worth restoring later. */
function losesDraft(current: AgentDraft, next: DraftContent, overwritten: boolean): boolean {
  if (isEmpty(current) || sameContent(current, next)) return false;
  const shrunk =
    current.text.length >= MIN_SHRINK_SNAPSHOT_CHARS && next.text.length < current.text.length / 2;
  return isEmpty(next) || shrunk || overwritten;
}

export function applyDraftSet(
  fields: StoredAgentDraftFields,
  input: DraftSetInput,
  policy: DraftPolicy,
): DraftTransition {
  let history = pruneHistory(fields.draftHistory, policy);
  const current = fields.draft;
  const next = { text: input.text, attachments: input.attachments };
  if (current && sameContent(current, next)) {
    return { fields: { ...fields, draftHistory: history }, accepted: true };
  }
  const stale = current !== undefined && input.baseRevision !== current.revision;

  // A writer that missed the latest revision competes on its clock: older loses.
  if (current && stale && input.updatedAt < current.updatedAt) {
    if (!isEmpty(next)) history = pushSnapshot(history, next, policy.now);
    return { fields: { ...fields, draftHistory: history }, accepted: false };
  }

  const overwritten = stale && current?.updatedBy !== input.clientId;
  if (current && losesDraft(current, next, overwritten)) {
    history = pushSnapshot(history, current, policy.now);
  }

  return {
    fields: {
      draft: {
        text: next.text,
        attachments: next.attachments,
        revision: (current?.revision ?? 0) + 1,
        updatedAt: input.updatedAt,
        updatedBy: input.clientId,
      },
      draftHistory: history,
    },
    accepted: true,
  };
}

export function applyDraftRestore(
  fields: StoredAgentDraftFields,
  input: { snapshotId: string; clientId: string },
  policy: DraftPolicy,
): DraftTransition {
  let history = pruneHistory(fields.draftHistory, policy);
  const snapshot = history.find((entry) => entry.id === input.snapshotId);
  if (!snapshot) throw new Error("That draft is no longer in the history.");
  const current = fields.draft;
  if (current && !isEmpty(current) && !sameContent(current, snapshot)) {
    history = pushSnapshot(history, current, policy.now);
  }
  return {
    fields: {
      ...fields,
      draft: {
        text: snapshot.text,
        attachments: snapshot.attachments,
        revision: (current?.revision ?? 0) + 1,
        // Restoring is a fresh edit; it must beat whatever the draft held.
        updatedAt: Math.max(policy.now, (current?.updatedAt ?? 0) + 1),
        updatedBy: input.clientId,
      },
      draftHistory: history,
    },
    accepted: true,
  };
}

export function summarizeHistory(
  history: StoredAgentDraftSnapshot[] | undefined,
): AgentDraftSnapshotSummary[] {
  return (history ?? []).map((snapshot) => ({
    id: snapshot.id,
    createdAt: snapshot.createdAt,
    preview: snapshot.text.replace(/\s+/g, " ").trim().slice(0, PREVIEW_CHARS),
    attachmentCount: snapshot.attachments.length,
  }));
}

function toState(fields: StoredAgentDraftFields): AgentDraftState {
  return { draft: fields.draft ?? null, history: summarizeHistory(fields.draftHistory) };
}

function sameHistory(
  a: StoredAgentDraftSnapshot[] | undefined,
  b: StoredAgentDraftSnapshot[] | undefined,
): boolean {
  return (a ?? []).map((s) => s.id).join() === (b ?? []).map((s) => s.id).join();
}

/**
 * Owns the unsent composer draft of every agent: last-write-wins updates, the
 * restore history, and deleting draft uploads nothing references any more.
 * Persisted on the stored agent record, so it survives a daemon restart.
 */
export class AgentDraftService {
  private readonly storage: AgentStorage;
  private readonly paseoHome: string;
  private readonly logger: pino.Logger;
  private readonly retentionDays: () => number;
  private readonly listeners = new Set<DraftListener>();

  constructor(options: {
    storage: AgentStorage;
    paseoHome: string;
    logger: pino.Logger;
    retentionDays?: () => number | undefined;
  }) {
    this.storage = options.storage;
    this.paseoHome = options.paseoHome;
    this.logger = options.logger.child({ module: "agent-draft" });
    this.retentionDays = () => options.retentionDays?.() ?? DEFAULT_DRAFT_HISTORY_RETENTION_DAYS;
  }

  subscribe(listener: DraftListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async getState(agentId: string): Promise<AgentDraftState | null> {
    const record = await this.storage.get(agentId);
    if (!record) return null;
    return toState({
      draft: record.draft,
      draftHistory: pruneHistory(record.draftHistory, this.policy()),
    });
  }

  async set(
    agentId: string,
    input: DraftSetInput,
  ): Promise<{ accepted: boolean; state: AgentDraftState } | null> {
    // Archiving deleted the draft and its uploads; a lingering client must not recreate them.
    if ((await this.storage.get(agentId))?.archivedAt) throw new Error("The agent is archived.");
    return this.mutate(agentId, (fields) => applyDraftSet(fields, input, this.policy()));
  }

  async restore(
    agentId: string,
    input: { snapshotId: string; clientId: string },
  ): Promise<{ accepted: boolean; state: AgentDraftState } | null> {
    return this.mutate(agentId, (fields) => applyDraftRestore(fields, input, this.policy()));
  }

  /** Drops the draft, its history and their image uploads. Called when the agent is archived. */
  async clearForArchive(agentId: string): Promise<void> {
    const released = await this.storage.mutateDraft(agentId, (fields) => ({
      fields: {},
      result: releasedUploadIds(fields, {}),
    }));
    if (released === null) return;
    await this.deleteUploads(released);
    this.emit({ agentId, draft: null, history: [] });
  }

  /** Reads an upload the agent's draft or history references, as base64. */
  async readUpload(agentId: string, uploadId: string): Promise<{ fileName: string; data: string }> {
    const record = await this.storage.get(agentId);
    if (!record || !UPLOAD_ID_PATTERN.test(uploadId)) throw new Error("Upload not found.");
    if (!referencedUploadIds(record).has(uploadId)) throw new Error("Upload not found.");
    const dir = join(this.paseoHome, "uploads", uploadId);
    const [fileName] = await readdir(dir);
    if (!fileName) throw new Error("Upload not found.");
    const path = join(dir, fileName);
    if ((await stat(path)).size > MAX_UPLOAD_READ_BYTES) throw new Error("Upload is too large.");
    return { fileName, data: (await readFile(path)).toString("base64") };
  }

  private policy(): DraftPolicy {
    return { now: Date.now(), retentionMs: this.retentionDays() * DAY_MS };
  }

  private async mutate(
    agentId: string,
    transition: (fields: StoredAgentDraftFields) => DraftTransition,
  ): Promise<{ accepted: boolean; state: AgentDraftState } | null> {
    const outcome = await this.storage.mutateDraft(agentId, (fields) => {
      const next = transition(fields);
      return {
        fields: next.fields,
        result: {
          accepted: next.accepted,
          state: toState(next.fields),
          released: releasedUploadIds(fields, next.fields),
          draftChanged: next.fields.draft !== fields.draft,
          historyChanged: !sameHistory(fields.draftHistory, next.fields.draftHistory),
        },
      };
    });
    if (!outcome) return null;
    await this.deleteUploads(outcome.released);
    if (outcome.draftChanged || outcome.historyChanged) {
      this.emit({
        agentId,
        draft: outcome.state.draft,
        ...(outcome.historyChanged ? { history: outcome.state.history } : {}),
      });
    }
    return { accepted: outcome.accepted, state: outcome.state };
  }

  private async deleteUploads(uploadIds: string[]): Promise<void> {
    for (const uploadId of uploadIds) {
      if (!UPLOAD_ID_PATTERN.test(uploadId)) continue;
      await rm(join(this.paseoHome, "uploads", uploadId), { recursive: true, force: true }).catch(
        (error) => this.logger.warn({ err: error, uploadId }, "Failed to delete draft upload"),
      );
    }
  }

  private emit(change: AgentDraftChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch (error) {
        this.logger.warn({ err: error }, "Draft listener failed");
      }
    }
  }
}
