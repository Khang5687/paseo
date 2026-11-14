import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Logger } from "pino";
import type { JsonValue } from "@getpaseo/protocol/agent-types";

import { writeJsonFileAtomic } from "../atomic-file.js";
import {
  AgentFeatureSchema,
  AgentOptionControlSchema,
  AgentQueuedMessagePayloadSchema,
  AgentStatusSchema,
} from "../messages.js";
import { toStoredAgentRecord } from "./agent-projections.js";
import type { ManagedAgent } from "./agent-manager.js";
import type { AgentSessionConfig } from "./agent-sdk-types.js";
import { AgentOwnerSchema, daemonExecutionKey, type DaemonAgentOwner } from "./agent-owner.js";
import { controlsFromFeatures } from "@getpaseo/protocol/option-controls";
import { foldFeatureValues } from "./option-controls.js";

const SERIALIZABLE_CONFIG_SCHEMA = z
  .object({
    modeId: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    thinkingOptionId: z.string().nullable().optional(),
    // COMPAT(featureValues): added in v0.15.0, remove after 2027-05-01. Read-only; folded on parse.
    featureValues: z.record(z.string(), z.unknown()).nullable().optional(),
    providerOptions: z.record(z.string(), z.unknown()).nullable().optional(),
    toolPolicy: z
      .object({
        preapproved: z.array(
          z.object({ kind: z.literal("mcp"), server: z.string(), tool: z.string() }).strict(),
        ),
      })
      .strict()
      .nullable()
      .optional(),
    systemPrompt: z.string().nullable().optional(),
    mcpServers: z.record(z.string(), z.any()).nullable().optional(),
  })
  .nullable()
  .optional();

const PERSISTENCE_HANDLE_SCHEMA = z
  .object({
    provider: z.string(),
    sessionId: z.string(),
    nativeHandle: z.any().optional(),
    metadata: z.record(z.string(), z.any()).optional(),
  })
  .nullable()
  .optional();

const STORED_DRAFT_ATTACHMENT_SCHEMA = z.object({
  kind: z.string(),
  uploadId: z.string().optional(),
  value: z.unknown(),
});

const STORED_DRAFT_SCHEMA = z.object({
  text: z.string(),
  attachments: z.array(STORED_DRAFT_ATTACHMENT_SCHEMA),
  revision: z.number().int().nonnegative(),
  updatedAt: z.number(),
  updatedBy: z.string(),
});

const STORED_DRAFT_SNAPSHOT_SCHEMA = z.object({
  id: z.string(),
  createdAt: z.number(),
  text: z.string(),
  attachments: z.array(STORED_DRAFT_ATTACHMENT_SCHEMA),
});

const RAW_STORED_AGENT_SCHEMA = z.object({
  id: z.string(),
  provider: z.string(),
  cwd: z.string(),
  workspaceId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastActivityAt: z.string().optional(),
  lastUserMessageAt: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  labels: z.record(z.string(), z.string()).default({}),
  metadata: z.record(z.string(), z.custom<JsonValue>()).default({}),
  lastStatus: AgentStatusSchema.default("closed"),
  resumeOnStartup: z.boolean().optional(),
  lastModeId: z.string().nullable().optional(),
  config: SERIALIZABLE_CONFIG_SCHEMA,
  launchEnv: z.record(z.string(), z.string()).optional(),
  runtimeInfo: z
    .object({
      provider: z.string(),
      sessionId: z.string().nullable(),
      model: z.string().nullable().optional(),
      thinkingOptionId: z.string().nullable().optional(),
      modeId: z.string().nullable().optional(),
      extra: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  controls: z.array(AgentOptionControlSchema).optional(),
  // COMPAT(featureValues): added in v0.15.0, remove after 2027-05-01. Read-only; becomes controls.
  features: z.array(AgentFeatureSchema).optional(),
  persistence: PERSISTENCE_HANDLE_SCHEMA,
  lastError: z.string().nullable().optional(),
  requiresAttention: z.boolean().optional(),
  attentionReason: z.enum(["finished", "error", "permission"]).nullable().optional(),
  attentionTimestamp: z.string().nullable().optional(),
  internal: z.boolean().optional(),
  // Daemon-owned message queue. Full payloads (image bytes, attachments) so the
  // daemon can replay a queued message without the client that queued it.
  queuedMessages: z.array(AgentQueuedMessagePayloadSchema).optional(),
  // Stops the automatic drain; absent = not paused.
  queuePaused: z.boolean().optional(),
  // Why the daemon paused the queue after a failed send; absent = no reason.
  queuePauseReason: z.string().optional(),
  background: z.boolean().optional(),
  archivedAt: z.string().nullable().optional(),
  owner: AgentOwnerSchema.optional(),
  // Truncated copies of the first user message and latest assistant message. The daemon
  // does not persist timelines, so search_agents reads these once the agent is unloaded.
  firstUserMessage: z.string().nullable().optional(),
  lastAssistantMessage: z.string().nullable().optional(),
  // The unsent composer draft and its restore history. Only AgentDraftService
  // writes these (see mutateDraft); every other write keeps the stored value.
  draft: STORED_DRAFT_SCHEMA.optional(),
  draftHistory: z.array(STORED_DRAFT_SNAPSHOT_SCHEMA).optional(),
});

export type SerializableAgentConfig = Pick<
  AgentSessionConfig,
  | "modeId"
  | "model"
  | "thinkingOptionId"
  | "providerOptions"
  | "toolPolicy"
  | "systemPrompt"
  | "mcpServers"
>;

type RawStoredAgentRecord = z.infer<typeof RAW_STORED_AGENT_SCHEMA>;
type RawStoredAgentConfig = NonNullable<RawStoredAgentRecord["config"]>;

/** Records carry `providerOptions` and `controls` only; legacy fields are folded when read. */
export type StoredAgentRecord = Omit<RawStoredAgentRecord, "config" | "features"> & {
  config?: Omit<RawStoredAgentConfig, "featureValues"> | null;
};
export type StoredAgentDraft = z.infer<typeof STORED_DRAFT_SCHEMA>;
export type StoredAgentDraftSnapshot = z.infer<typeof STORED_DRAFT_SNAPSHOT_SCHEMA>;
export type StoredAgentDraftFields = Pick<StoredAgentRecord, "draft" | "draftHistory">;

// COMPAT(featureValues): added in v0.15.0, remove after 2027-05-01.
function foldLegacyRecordFields(record: RawStoredAgentRecord): StoredAgentRecord {
  const { features, config, controls, ...rest } = record;
  return {
    ...rest,
    ...(config ? { config: foldFeatureValues(config) } : { config }),
    ...((controls ?? features) ? { controls: controls ?? controlsFromFeatures(features) } : {}),
  };
}

const STORED_AGENT_SCHEMA = RAW_STORED_AGENT_SCHEMA.transform(foldLegacyRecordFields);
export function parseStoredAgentRecord(value: unknown): StoredAgentRecord {
  return STORED_AGENT_SCHEMA.parse(value);
}

const SEARCHABLE_MESSAGE_MAX_CHARS = 2000;

/** The stored form of firstUserMessage/lastAssistantMessage. */
export function toSearchableMessage(text: string | null | undefined): string | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  return trimmed.length > SEARCHABLE_MESSAGE_MAX_CHARS
    ? trimmed.slice(0, SEARCHABLE_MESSAGE_MAX_CHARS)
    : trimmed;
}

type SearchableMessages = Pick<StoredAgentRecord, "firstUserMessage" | "lastAssistantMessage">;

/**
 * The first user message is sticky: an agent reloaded without its history would otherwise
 * replace it with the first prompt sent after the reload. The latest reply always wins.
 */
function mergeSearchableMessages(
  existing: SearchableMessages | null,
  next: SearchableMessages | undefined,
): SearchableMessages {
  const firstUserMessage = existing?.firstUserMessage ?? next?.firstUserMessage ?? null;
  const lastAssistantMessage = next?.lastAssistantMessage ?? existing?.lastAssistantMessage ?? null;
  return {
    ...(firstUserMessage !== null ? { firstUserMessage } : {}),
    ...(lastAssistantMessage !== null ? { lastAssistantMessage } : {}),
  };
}

export class AgentStorage {
  private cache: Map<string, StoredAgentRecord> = new Map();
  private pathById: Map<string, string> = new Map();
  private pathsById: Map<string, Set<string>> = new Map();
  private pendingWrites: Map<string, Promise<void>> = new Map();
  private deleting: Set<string> = new Set();
  private daemonAgentIdsByExecution: Map<string, string> = new Map();
  private daemonExecutionKeysByAgentId: Map<string, string> = new Map();
  private readonly idsByWorkspace = new Map<string, Set<string>>();
  private readonly workspaceById = new Map<string, string>();
  private readonly activeIds = new Set<string>();
  private readonly promptTimeByAgent = new Map<string, string>();
  private readonly promptTimes = new Map<string, string>();
  private loaded = false;
  private baseDir: string;
  private loadPromise: Promise<void> | null = null;
  private logger: Logger;

  constructor(baseDir: string, logger: Logger) {
    this.baseDir = baseDir;
    this.logger = logger.child({ module: "agent", component: "agent-storage" });
  }

  async initialize(): Promise<void> {
    await this.load();
  }

  async listAll(): Promise<StoredAgentRecord[]> {
    await this.load();
    return Array.from(this.cache.values());
  }

  async listActive(options?: { includeArchived?: boolean }): Promise<StoredAgentRecord[]> {
    await this.load();
    return Array.from(
      options?.includeArchived ? this.cache.keys() : this.activeIds,
      (id) => this.cache.get(id)!,
    );
  }

  async listByWorkspaces(
    workspaceIds: Iterable<string>,
    options?: { includeArchived?: boolean },
  ): Promise<StoredAgentRecord[]> {
    await this.load();
    const records: StoredAgentRecord[] = [];
    for (const workspaceId of new Set(workspaceIds)) {
      for (const id of this.idsByWorkspace.get(workspaceId) ?? []) {
        const record = this.cache.get(id)!;
        if (options?.includeArchived || !record.archivedAt) records.push(record);
      }
    }
    return records;
  }

  async lastUserMessageAtByWorkspace(
    workspaceIds?: Iterable<string>,
    options?: { excludeAgentIds?: Iterable<string> },
  ): Promise<ReadonlyMap<string, string>> {
    await this.load();
    const times = new Map<string, string>();
    const excluded = new Set(options?.excludeAgentIds);
    const affected = new Set(Array.from(excluded, (id) => this.workspaceById.get(id)));
    for (const id of workspaceIds ?? this.promptTimes.keys()) {
      let at = this.promptTimes.get(id);
      if (affected.has(id)) {
        at = undefined;
        for (const agentId of this.idsByWorkspace.get(id) ?? []) {
          const record = this.cache.get(agentId)!;
          if (
            !excluded.has(agentId) &&
            !record.internal &&
            !record.background &&
            record.lastUserMessageAt &&
            record.lastUserMessageAt > (at ?? "")
          ) {
            at = record.lastUserMessageAt;
          }
        }
      }
      if (at) times.set(id, at);
    }
    return times;
  }

  private indexWorkspace(record: StoredAgentRecord): void {
    const previous = this.workspaceById.get(record.id);
    if (previous) this.idsByWorkspace.get(previous)?.delete(record.id);
    this.workspaceById.delete(record.id);
    this.activeIds.delete(record.id);
    if (!record.archivedAt) this.activeIds.add(record.id);
    if (record.workspaceId) {
      const ids = this.idsByWorkspace.get(record.workspaceId) ?? new Set<string>();
      ids.add(record.id);
      this.idsByWorkspace.set(record.workspaceId, ids);
      this.workspaceById.set(record.id, record.workspaceId);
    }
    this.indexPromptTime(record, previous);
  }

  private indexPromptTime(record: StoredAgentRecord, previous: string | undefined): void {
    const previousTime = this.promptTimeByAgent.get(record.id);
    const nextTime =
      !record.internal && !record.background ? (record.lastUserMessageAt ?? undefined) : undefined;
    if (nextTime) this.promptTimeByAgent.set(record.id, nextTime);
    else this.promptTimeByAgent.delete(record.id);
    if (previous === record.workspaceId && previousTime === nextTime) return;
    if (
      previous &&
      previousTime &&
      this.promptTimes.get(previous) === previousTime &&
      (previous !== record.workspaceId || !nextTime || nextTime < previousTime)
    ) {
      this.refreshPromptTime(previous);
    }
    if (
      record.workspaceId &&
      nextTime &&
      nextTime > (this.promptTimes.get(record.workspaceId) ?? "")
    ) {
      this.promptTimes.set(record.workspaceId, nextTime);
    }
  }

  private refreshPromptTime(workspaceId: string): void {
    this.promptTimes.delete(workspaceId);
    let latest = "";
    for (const id of this.idsByWorkspace.get(workspaceId) ?? []) {
      const record = this.cache.get(id)!;
      if (
        !record.internal &&
        !record.background &&
        record.lastUserMessageAt &&
        record.lastUserMessageAt > latest
      )
        latest = record.lastUserMessageAt;
    }
    if (latest) this.promptTimes.set(workspaceId, latest);
  }

  async get(agentId: string): Promise<StoredAgentRecord | null> {
    await this.load();
    return this.cache.get(agentId) ?? null;
  }

  async listByProviderSession(
    provider: string,
    providerHandleId: string,
  ): Promise<StoredAgentRecord[]> {
    await this.load();
    return Array.from(this.cache.values()).filter(
      (record) =>
        record.persistence?.provider === provider &&
        (record.persistence.sessionId === providerHandleId ||
          record.persistence.nativeHandle === providerHandleId),
    );
  }

  async listByWorkspace(workspaceId: string): Promise<StoredAgentRecord[]> {
    return this.listByWorkspaces([workspaceId], { includeArchived: true });
  }

  async findByDaemonExecution(owner: DaemonAgentOwner): Promise<StoredAgentRecord | null> {
    await this.load();
    const agentId = this.daemonAgentIdsByExecution.get(daemonExecutionKey(owner));
    return agentId ? (this.cache.get(agentId) ?? null) : null;
  }

  async upsert(record: StoredAgentRecord): Promise<void> {
    await this.load();
    await this.queueRecordWrite(record);
  }

  private queueRecordWrite(record: StoredAgentRecord): Promise<void> {
    return this.queueRecordMutation(record.id, () => record);
  }

  /**
   * Replaces the draft fields of a stored agent inside its write queue. Returns
   * null without writing when the agent has no record.
   */
  async mutateDraft<T>(
    agentId: string,
    mutate: (fields: StoredAgentDraftFields) => { fields: StoredAgentDraftFields; result: T },
  ): Promise<T | null> {
    await this.load();
    let result: T | null = null;
    await this.queueRecordMutation(
      agentId,
      (existing) => {
        if (!existing) return null;
        const next = mutate({ draft: existing.draft, draftHistory: existing.draftHistory });
        result = next.result;
        return withDraftFields(existing, next.fields);
      },
      { ownsDraft: true },
    );
    return result;
  }

  private queueRecordMutation(
    agentId: string,
    mutate: (existing: StoredAgentRecord | null) => StoredAgentRecord | null,
    options?: { ownsDraft?: boolean },
  ): Promise<void> {
    const prev = this.pendingWrites.get(agentId) ?? Promise.resolve();
    const next = prev.then(async () => {
      if (this.deleting.has(agentId)) {
        return undefined;
      }

      const existing = this.cache.get(agentId) ?? null;
      const mutated = mutate(existing);
      if (!mutated) return undefined;
      // Writers outside the draft service build records from older reads or
      // from the live agent; the draft they carry is stale, so keep the stored one.
      const record = options?.ownsDraft ? mutated : withDraftFields(mutated, existing ?? {});
      await this.writeRecord(record);
      return undefined;
    });

    const tracked = next.finally(() => {
      if (this.pendingWrites.get(agentId) === tracked) {
        this.pendingWrites.delete(agentId);
      }
    });

    this.pendingWrites.set(agentId, tracked);
    return tracked;
  }

  private async writeRecord(record: StoredAgentRecord): Promise<void> {
    const agentId = record.id;
    const nextPath = this.buildRecordPath(record);
    const previousPath = this.pathById.get(agentId);

    await writeJsonFileAtomic(nextPath, record);
    this.addIndexedPath(agentId, nextPath);

    if (previousPath && previousPath !== nextPath) {
      try {
        await fs.unlink(previousPath);
      } catch {
        // ignore cleanup errors
      }
      this.removeIndexedPath(agentId, previousPath);
    }

    this.cache.set(agentId, record);
    this.indexOwner(record);
    this.pathById.set(agentId, nextPath);
  }

  beginDelete(agentId: string): void {
    this.deleting.add(agentId);
  }

  async remove(agentId: string): Promise<void> {
    await this.load();
    this.beginDelete(agentId);
    await (this.pendingWrites.get(agentId) ?? Promise.resolve());
    const paths = Array.from(this.pathsById.get(agentId) ?? []);
    await Promise.all(
      paths.map(async (filePath) => {
        try {
          await fs.unlink(filePath);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code && code !== "ENOENT") {
            this.logger.warn(
              { err: error, agentId, filePath },
              "Failed to remove agent record file",
            );
          }
        }
      }),
    );

    const workspaceId = this.workspaceById.get(agentId);
    this.workspaceById.delete(agentId);
    this.promptTimeByAgent.delete(agentId);
    this.activeIds.delete(agentId);
    if (workspaceId) {
      this.idsByWorkspace.get(workspaceId)?.delete(agentId);
      this.refreshPromptTime(workspaceId);
    }
    this.cache.delete(agentId);
    this.removeOwnerIndex(agentId);
    this.pathById.delete(agentId);
    this.pathsById.delete(agentId);
  }

  async applySnapshot(
    agent: ManagedAgent,
    options?: {
      title?: string | null;
      internal?: boolean;
      messages?: { firstUserMessage: string | null; lastAssistantMessage: string | null };
    },
  ): Promise<void> {
    await this.load();
    const hasTitleOverride =
      options !== undefined && Object.prototype.hasOwnProperty.call(options, "title");
    const hasInternalOverride =
      options !== undefined && Object.prototype.hasOwnProperty.call(options, "internal");
    await this.queueRecordMutation(agent.id, (existing) => {
      const record = toStoredAgentRecord(agent, {
        title: hasTitleOverride ? (options?.title ?? null) : (existing?.title ?? null),
        createdAt: existing?.createdAt,
        internal: hasInternalOverride ? options?.internal : (agent.internal ?? existing?.internal),
      });

      // Preserve soft-delete/archive status across snapshot flushes. The
      // projection runs inside the per-agent write queue so it cannot commit a
      // stale pre-archive record after the archive mutation.
      if (existing && existing.archivedAt !== undefined) {
        record.archivedAt = existing.archivedAt;
      }
      Object.assign(record, mergeSearchableMessages(existing, options?.messages));
      // Background is fixed at creation; a runtime opened without it cannot clear it.
      if (existing?.background) record.background = true;
      record.resumeOnStartup =
        existing?.resumeOnStartup && agent.lifecycle !== "idle" && agent.lifecycle !== "error";
      return record;
    });
  }

  async setTitle(agentId: string, title: string): Promise<void> {
    await this.load();
    await this.waitForPendingWrite(agentId);
    const record = await this.get(agentId);
    if (!record) {
      throw new Error(`Agent ${agentId} not found`);
    }
    await this.upsert({ ...record, title });
  }

  async flush(): Promise<void> {
    await this.load().catch(() => undefined);
    const writes = Array.from(this.pendingWrites.values());
    await Promise.allSettled(writes);
  }

  private async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    if (!this.loadPromise) {
      this.loadPromise = this.doLoad();
    }

    return this.loadPromise;
  }

  private async doLoad(): Promise<void> {
    this.cache.clear();
    this.pathById.clear();
    this.pathsById.clear();
    this.daemonAgentIdsByExecution.clear();
    this.daemonExecutionKeysByAgentId.clear();

    try {
      await this.scanDisk();
      this.loaded = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.loaded = true;
        return;
      }
      this.logger.error({ err: error }, "Failed to load agents");
      this.loaded = true;
    }
  }

  private async scanDisk(): Promise<void> {
    let entries: Dirent[] = [];
    try {
      entries = await fs.readdir(this.baseDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }

    const rootRecordPaths = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.join(this.baseDir, entry.name));

    const projectDirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(this.baseDir, entry.name));

    const projectFileLists = await Promise.all(
      projectDirs.map(async (projectDir) => {
        try {
          const files = await fs.readdir(projectDir, { withFileTypes: true });
          return files
            .filter((file) => file.isFile() && file.name.endsWith(".json"))
            .map((file) => path.join(projectDir, file.name));
        } catch {
          return [];
        }
      }),
    );

    const allFilePaths = [...rootRecordPaths, ...projectFileLists.flat()];
    const loaded = await Promise.all(
      allFilePaths.map(async (filePath) => {
        const record = await this.readRecordFile(filePath);
        return record ? { record, filePath } : null;
      }),
    );

    for (const item of loaded) {
      if (!item) continue;
      const { record, filePath } = item;
      this.cache.set(record.id, record);
      this.indexOwner(record);
      this.pathById.set(record.id, filePath);
      this.addIndexedPath(record.id, filePath);
    }
  }

  private async readRecordFile(filePath: string): Promise<StoredAgentRecord | null> {
    try {
      const content = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(content);
      return parseStoredAgentRecord(parsed);
    } catch (error) {
      this.logger.error({ err: error, filePath }, "Skipping invalid agent record");
      return null;
    }
  }

  private buildRecordPath(record: StoredAgentRecord): string {
    const projectDir = projectDirNameFromCwd(record.cwd);
    return path.join(this.baseDir, projectDir, `${record.id}.json`);
  }

  private addIndexedPath(agentId: string, filePath: string): void {
    const paths = this.pathsById.get(agentId) ?? new Set<string>();
    paths.add(filePath);
    this.pathsById.set(agentId, paths);
  }

  private removeIndexedPath(agentId: string, filePath: string): void {
    const paths = this.pathsById.get(agentId);
    if (!paths) {
      return;
    }
    paths.delete(filePath);
    if (paths.size === 0) {
      this.pathsById.delete(agentId);
    }
  }

  private indexOwner(record: StoredAgentRecord): void {
    this.indexWorkspace(record);
    this.removeOwnerIndex(record.id);
    if (record.owner?.kind === "daemon") {
      const key = daemonExecutionKey(record.owner);
      const previousAgentId = this.daemonAgentIdsByExecution.get(key);
      if (previousAgentId && previousAgentId !== record.id) {
        this.daemonExecutionKeysByAgentId.delete(previousAgentId);
      }
      this.daemonAgentIdsByExecution.set(key, record.id);
      this.daemonExecutionKeysByAgentId.set(record.id, key);
    }
  }

  private removeOwnerIndex(agentId: string): void {
    const key = this.daemonExecutionKeysByAgentId.get(agentId);
    if (!key) return;
    if (this.daemonAgentIdsByExecution.get(key) === agentId) {
      this.daemonAgentIdsByExecution.delete(key);
    }
    this.daemonExecutionKeysByAgentId.delete(agentId);
  }

  private async waitForPendingWrite(agentId: string): Promise<void> {
    await (this.pendingWrites.get(agentId) ?? Promise.resolve()).catch(() => undefined);
  }
}

function withDraftFields(
  record: StoredAgentRecord,
  fields: StoredAgentDraftFields,
): StoredAgentRecord {
  const { draft: _draft, draftHistory: _history, ...rest } = record;
  return {
    ...rest,
    ...(fields.draft ? { draft: fields.draft } : {}),
    ...(fields.draftHistory?.length ? { draftHistory: fields.draftHistory } : {}),
  };
}

function projectDirNameFromCwd(cwd: string): string {
  // path.win32.parse handles drive letters, UNC roots, and Unix roots on all platforms
  const { root } = path.win32.parse(cwd);
  const withoutRoot = cwd.slice(root.length).replace(/[\\/]+$/, "");
  // Sanitize root: strip colons and separators, keep letters (e.g. "C:\" → "C", "\\server\share\" → "server-share")
  const sanitizedRoot = root.replace(/[:\\/]+/g, "-").replace(/^-+|-+$/g, "");
  const prefix = sanitizedRoot ? sanitizedRoot + "-" : "";
  if (!withoutRoot) {
    return sanitizedRoot || "root";
  }
  return prefix + withoutRoot.replace(/[\\/]+/g, "-");
}
