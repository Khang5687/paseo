import type { Logger } from "pino";

import {
  AgentRunCancellationError,
  type AgentRunCancellationResult,
  type ManagedAgent,
} from "./agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent-storage.js";
import type { AgentProviderNotice } from "./agent-sdk-types.js";
import { unarchiveAgentState, type AgentUnarchiveController } from "./agent-prompt.js";
import { AgentNotFoundError } from "./agent-loading.js";
import type { PersistedWorkspaceRecord } from "../workspace-registry.js";

export type LifecycleAgentSnapshot = Pick<ManagedAgent, "id" | "cwd" | "lifecycle" | "internal">;

export interface LifecycleAgentManager {
  getAgent(agentId: string): LifecycleAgentSnapshot | null;
  hasInFlightRun(agentId: string): boolean;
  cancelAgentRun(agentId: string): Promise<AgentRunCancellationResult>;
  clearAgentAttention(agentId: string): Promise<void>;
  archiveAgent(agentId: string): Promise<{ archivedAt: string }>;
  archiveSnapshot(agentId: string, archivedAt: string): Promise<StoredAgentRecord>;
  closeAgent(agentId: string): Promise<void>;
  setLabels(agentId: string, labels: Record<string, string>): Promise<void>;
  detachAgent(agentId: string): Promise<{
    record: StoredAgentRecord;
    live: boolean;
    previousParentAgentId: string | null;
  }>;
  notifyAgentState(agentId: string): void;
  setAgentMode(agentId: string, modeId: string): Promise<AgentProviderNotice | null>;
  updateAgentMetadata(
    agentId: string,
    updates: {
      title?: string;
      labels?: Record<string, string>;
    },
  ): Promise<void>;
}

export interface LifecycleAgentStorage {
  get(agentId: string): Promise<StoredAgentRecord | null>;
  upsert(record: StoredAgentRecord): Promise<void>;
}

export interface AgentLifecycleCommandDependencies {
  agentManager: LifecycleAgentManager;
  agentStorage: LifecycleAgentStorage;
  logger: Logger;
}

export interface CancelAgentRunResult {
  agent: LifecycleAgentSnapshot;
  cancelled: boolean;
}

interface RequestedAgentRunCancellation extends CancelAgentRunResult {
  cancellation: AgentRunCancellationResult;
}

async function requestAgentRunCancellation(
  dependencies: Pick<AgentLifecycleCommandDependencies, "agentManager" | "logger">,
  agentId: string,
): Promise<RequestedAgentRunCancellation> {
  const { agentManager, logger } = dependencies;
  const agent = agentManager.getAgent(agentId);
  if (!agent) {
    logger.trace({ agentId }, "cancelAgentRunCommand: agent not found");
    throw new Error(`Agent ${agentId} not found`);
  }

  const hasInFlightRun = agentManager.hasInFlightRun(agentId);
  if (!hasInFlightRun) {
    logger.trace(
      { agentId, lifecycle: agent.lifecycle, hasInFlightRun },
      "cancelAgentRunCommand: skipping because agent is not running",
    );
    return { agent, cancelled: false, cancellation: { status: "not_running" } };
  }

  logger.debug(
    { agentId, lifecycle: agent.lifecycle, hasInFlightRun },
    "cancelAgentRunCommand: interrupting",
  );
  const startedAt = Date.now();
  const cancellation = await agentManager.cancelAgentRun(agentId);
  logger.debug(
    { agentId, cancellation: cancellation.status, durationMs: Date.now() - startedAt },
    "cancelAgentRunCommand: cancelAgentRun completed",
  );

  return {
    agent,
    cancelled: cancellation.status === "settled",
    cancellation,
  };
}

export async function cancelAgentRunCommand(
  dependencies: Pick<AgentLifecycleCommandDependencies, "agentManager" | "logger">,
  agentId: string,
): Promise<CancelAgentRunResult> {
  const result = await requestAgentRunCancellation(dependencies, agentId);
  if (result.cancellation.status === "refused") {
    dependencies.logger.warn(
      { agentId },
      "cancelAgentRunCommand: reported running but no active run was cancelled",
    );
    throw new AgentRunCancellationError(agentId, "stop");
  }

  return { agent: result.agent, cancelled: result.cancelled };
}

export interface ArchiveAgentResult {
  agentId: string;
  archivedAt: string;
  /** Null for an internal agent, which is closed and leaves no record behind. */
  record: StoredAgentRecord | null;
}

export async function archiveAgentCommand(
  dependencies: AgentLifecycleCommandDependencies,
  agentId: string,
): Promise<ArchiveAgentResult> {
  const liveAgent = dependencies.agentManager.getAgent(agentId);
  let record: StoredAgentRecord | null;
  if (liveAgent) {
    await requestAgentRunCancellation(dependencies, agentId);
    await dependencies.agentManager.clearAgentAttention(agentId).catch(() => undefined);
    const archived = await dependencies.agentManager.archiveAgent(agentId);
    if (liveAgent.internal) {
      return { agentId, archivedAt: archived.archivedAt, record: null };
    }
    record = await dependencies.agentStorage.get(agentId);
  } else {
    record = await archiveStoredAgent(dependencies, agentId);
  }

  if (!record) {
    throw new Error(`Agent not found in storage after archive: ${agentId}`);
  }
  if (!record.archivedAt) {
    throw new Error(`Agent missing archivedAt after archive: ${agentId}`);
  }

  return {
    agentId,
    archivedAt: record.archivedAt,
    record,
  };
}

export interface UnarchiveAgentDependencies {
  agentManager: AgentUnarchiveController;
  agentStorage: AgentStorage;
  getWorkspace(workspaceId: string): Promise<PersistedWorkspaceRecord | null>;
  /** Clears the workspace's archivedAt and publishes the restored workspace to clients. */
  restoreWorkspace(workspace: PersistedWorkspaceRecord): Promise<void>;
  isDirectory(path: string): Promise<boolean>;
}

export interface UnarchiveAgentResult {
  agentId: string;
  /** False when the agent was already active; the call was then a no-op. */
  wasArchived: boolean;
  workspaceId: string | null;
  workspaceRestored: boolean;
  warning: string | null;
}

/**
 * Bring an archived agent back to the active list without starting a turn. Restores
 * its archived workspace first so clients can place the agent when it reappears.
 */
export async function unarchiveAgentCommand(
  dependencies: UnarchiveAgentDependencies,
  agentId: string,
): Promise<UnarchiveAgentResult> {
  const record = await dependencies.agentStorage.get(agentId);
  if (!record || record.internal) {
    throw new AgentNotFoundError(agentId);
  }
  const workspace = record.workspaceId ? await dependencies.getWorkspace(record.workspaceId) : null;
  const directory = workspace?.cwd ?? record.cwd;
  const directoryExists = await dependencies.isDirectory(directory);

  // A workspace whose directory is gone stays archived: the app's workspace recovery
  // can recreate a removed worktree, and an unarchived record would only show it broken.
  const workspaceRestored = Boolean(workspace?.archivedAt && directoryExists);
  if (workspace && workspaceRestored) {
    await dependencies.restoreWorkspace(workspace);
  }
  const wasArchived = await unarchiveAgentState(
    dependencies.agentStorage,
    dependencies.agentManager,
    agentId,
  );

  let warning: string | null = null;
  if (!directoryExists) {
    warning = `The agent's directory ${directory} no longer exists, so it cannot run until that directory exists again.`;
    if (workspace?.archivedAt) {
      warning += ` Its workspace ${workspace.workspaceId} stays archived; restore it from the app to recreate the worktree.`;
    }
  }

  return {
    agentId,
    wasArchived,
    workspaceId: workspace?.workspaceId ?? record.workspaceId ?? null,
    workspaceRestored,
    warning,
  };
}

export async function closeAgentCommand(
  dependencies: Pick<AgentLifecycleCommandDependencies, "agentManager">,
  agentId: string,
): Promise<void> {
  await dependencies.agentManager.closeAgent(agentId);
}

export interface UpdateAgentResult {
  accepted: boolean;
  error: string | null;
}

export async function updateAgentCommand(
  dependencies: Pick<AgentLifecycleCommandDependencies, "agentManager">,
  input: {
    agentId: string;
    name?: string;
    labels?: Record<string, string>;
  },
): Promise<UpdateAgentResult> {
  const title = input.name?.trim();
  const labels = input.labels && Object.keys(input.labels).length > 0 ? input.labels : undefined;

  if (!title && !labels) {
    return {
      accepted: false,
      error: "Nothing to update (provide name and/or labels)",
    };
  }

  await dependencies.agentManager.updateAgentMetadata(input.agentId, {
    ...(title ? { title } : {}),
    ...(labels ? { labels } : {}),
  });

  return {
    accepted: true,
    error: null,
  };
}

export interface DetachAgentResult {
  agentId: string;
  record: StoredAgentRecord;
  live: boolean;
  previousParentAgentId: string | null;
}

export async function detachAgentCommand(
  dependencies: Pick<AgentLifecycleCommandDependencies, "agentManager">,
  agentId: string,
): Promise<DetachAgentResult> {
  const result = await dependencies.agentManager.detachAgent(agentId);
  return {
    agentId,
    ...result,
  };
}

export async function setAgentModeCommand(
  dependencies: Pick<AgentLifecycleCommandDependencies, "agentManager">,
  input: {
    agentId: string;
    modeId: string;
  },
): Promise<{ modeId: string; notice: AgentProviderNotice | null }> {
  const notice = await dependencies.agentManager.setAgentMode(input.agentId, input.modeId);
  return { modeId: input.modeId, notice };
}

async function archiveStoredAgent(
  dependencies: Pick<AgentLifecycleCommandDependencies, "agentManager" | "agentStorage">,
  agentId: string,
): Promise<StoredAgentRecord> {
  const existing = await dependencies.agentStorage.get(agentId);
  if (!existing) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  if (existing.archivedAt) {
    return existing;
  }

  const archivedAt = new Date().toISOString();
  return dependencies.agentManager.archiveSnapshot(agentId, archivedAt);
}
