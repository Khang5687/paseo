import { z } from "zod";
import { PARENT_AGENT_ID_LABEL, PARENT_SERVER_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { expandUserPath, isSameOrDescendantPath } from "../../path-utils.js";

/**
 * Agent-facing tool output stays in the caller's context for every later turn, so list/create
 * tools return a compact projection by default. `detail: "full"` returns the complete payload.
 * Compaction runs once, at the tool boundary, so local and remote-host results shrink the same way.
 */

export const ToolDetailInputSchema = z
  .enum(["compact", "full"])
  .optional()
  .describe(
    'Output size. Default "compact" returns only the fields agents usually need; "full" returns the complete payload.',
  );

export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 200;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null || value === "" || value === false) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (isRecord(value)) return Object.keys(value).length === 0;
  return false;
}

/** Drops undefined, null, "", false, [] and {} entries. Zero is kept. */
export function omitEmpty(record: JsonRecord): JsonRecord {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => !isEmpty(value)));
}

export function isFullDetail(input: unknown): boolean {
  return isRecord(input) && input.detail === "full";
}

export function moreNote(more: number, hint: string): { more: number; note: string } {
  return { more, note: `${more} more not shown; ${hint}` };
}

export interface PageResult<T> {
  items: T[];
  more: number;
}

export interface WorkspaceSummaryLike {
  workspaceId: string;
  projectId: string;
  cwd: string;
  title?: string | null;
  isolation: string;
  background?: boolean;
}

/** Filters then truncates. Callers sort first; this keeps their order (newest first). */
export function selectWorkspaceSummaries<T extends WorkspaceSummaryLike>(
  summaries: readonly T[],
  options: { query?: string; projectId?: string; cwd?: string; limit?: number },
): PageResult<T> {
  const query = options.query?.trim().toLowerCase();
  const cwd = options.cwd?.trim() ? expandUserPath(options.cwd) : undefined;
  const matches = summaries.filter((summary) => {
    if (options.projectId && summary.projectId !== options.projectId) return false;
    if (cwd && !isSameOrDescendantPath(cwd, summary.cwd)) return false;
    if (
      query &&
      !(summary.title ?? "").toLowerCase().includes(query) &&
      !summary.cwd.toLowerCase().includes(query)
    ) {
      return false;
    }
    return true;
  });
  const limit = options.limit ?? DEFAULT_LIST_LIMIT;
  return { items: matches.slice(0, limit), more: Math.max(0, matches.length - limit) };
}

function countUserLabels(labels: unknown): number {
  if (!isRecord(labels)) return 0;
  return Object.keys(labels).filter((key) => !key.startsWith("paseo.")).length;
}

function labelValue(labels: unknown, key: string): string | undefined {
  if (!isRecord(labels)) return undefined;
  const value = labels[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function compactAgentCore(agent: JsonRecord): JsonRecord {
  return {
    id: agent.id,
    shortId: agent.shortId,
    title: agent.title,
    status: agent.status,
    provider: agent.provider,
    model: agent.model,
    cwd: agent.cwd,
    workspaceId: agent.workspaceId,
    attention: agent.requiresAttention ? (agent.attentionReason ?? "yes") : undefined,
    updatedAt: agent.updatedAt,
    archived: agent.archivedAt ? true : undefined,
    parentId: labelValue(agent.labels, PARENT_AGENT_ID_LABEL),
    parentServerId: labelValue(agent.labels, PARENT_SERVER_ID_LABEL),
    labelCount: countUserLabels(agent.labels),
    providerUnavailable: agent.providerUnavailable,
  };
}

export function compactAgentListItem(agent: unknown): unknown {
  return isRecord(agent) ? omitEmpty(compactAgentCore(agent)) : agent;
}

export function compactAgentSnapshot(snapshot: unknown): unknown {
  if (!isRecord(snapshot)) return snapshot;
  return omitEmpty({
    ...compactAgentCore(snapshot),
    currentModeId: snapshot.currentModeId,
    thinkingOptionId: snapshot.effectiveThinkingOptionId ?? snapshot.thinkingOptionId,
    lastError: snapshot.lastError,
    pendingPermissions: snapshot.pendingPermissions,
  });
}

export function compactWorkspace(workspace: unknown): unknown {
  if (!isRecord(workspace)) return workspace;
  return omitEmpty({
    workspaceId: workspace.workspaceId,
    title: workspace.title,
    cwd: workspace.cwd,
    projectId: workspace.projectId,
    isolation: workspace.isolation === "worktree" ? "worktree" : undefined,
    background: workspace.background,
  });
}

function compactOption(option: unknown): unknown {
  if (!isRecord(option)) return option;
  return omitEmpty({
    id: option.id,
    label: option.label === option.id ? undefined : option.label,
  });
}

function compactModel(model: unknown): unknown {
  if (!isRecord(model)) return model;
  return omitEmpty({
    id: model.id,
    label: model.label === model.id ? undefined : model.label,
    isDefault: model.isDefault,
  });
}

function compactProvider(provider: unknown): unknown {
  if (!isRecord(provider)) return provider;
  return omitEmpty({
    id: provider.id,
    label: provider.label === provider.id ? undefined : provider.label,
    status: provider.status,
    enabled: provider.enabled === false ? false : undefined,
    error: provider.error,
    modes: Array.isArray(provider.modes) ? provider.modes.map(compactOption) : undefined,
  });
}

const PROMPT_PREVIEW_CHARS = 100;

function compactSchedule(schedule: unknown): unknown {
  if (!isRecord(schedule)) return schedule;
  const target = isRecord(schedule.target) ? schedule.target : undefined;
  const config = target && isRecord(target.config) ? target.config : undefined;
  const prompt = typeof schedule.prompt === "string" ? schedule.prompt : undefined;
  return omitEmpty({
    id: schedule.id,
    name: schedule.name,
    status: schedule.status,
    cadence: schedule.cadence,
    promptPreview:
      prompt && prompt.length > PROMPT_PREVIEW_CHARS
        ? `${prompt.slice(0, PROMPT_PREVIEW_CHARS)}…`
        : prompt,
    provider: config?.provider,
    model: config?.model,
    cwd: config?.cwd,
    nextRunAt: schedule.nextRunAt,
    lastRunAt: schedule.lastRunAt,
    maxRuns: schedule.maxRuns,
    expiresAt: schedule.expiresAt,
  });
}

function mapArray(structured: JsonRecord, key: string, map: (item: unknown) => unknown) {
  const value = structured[key];
  return Array.isArray(value) ? { ...structured, [key]: value.map(map) } : structured;
}

export type ToolCompactor = (structured: JsonRecord, input: unknown) => JsonRecord;

/** Compactors by tool name. Each preserves unknown top-level keys such as `serverId` and `more`. */
export const TOOL_COMPACTORS: Readonly<Record<string, ToolCompactor>> = {
  list_agents: (structured) => mapArray(structured, "agents", compactAgentListItem),
  get_agent_status: (structured) =>
    "snapshot" in structured
      ? { ...structured, snapshot: compactAgentSnapshot(structured.snapshot) }
      : structured,
  list_workspaces: (structured) => mapArray(structured, "workspaces", compactWorkspace),
  create_workspace: (structured) => compactWorkspace(structured) as JsonRecord,
  create_agent: (structured) => {
    const { availableModes: _availableModes, ...rest } = structured;
    return omitEmpty(rest);
  },
  list_models: (structured, input) =>
    isRecord(input) && input.model ? structured : mapArray(structured, "models", compactModel),
  list_providers: (structured) => mapArray(structured, "providers", compactProvider),
  inspect_provider: (structured) => {
    const { description: _description, ...rest } = structured;
    const modes = Array.isArray(rest.modes) ? rest.modes.map(compactOption) : undefined;
    return omitEmpty({ ...rest, modes, features: rest.features });
  },
  list_schedules: (structured) => mapArray(structured, "schedules", compactSchedule),
  list_terminals: (structured, input) => {
    const terminals = structured.terminals;
    if (!Array.isArray(terminals)) return structured;
    const scoped = !(isRecord(input) && input.all);
    const cwds = new Set(terminals.map((terminal) => isRecord(terminal) && terminal.cwd));
    const sharedCwd = scoped && cwds.size === 1 ? [...cwds][0] : undefined;
    return {
      ...structured,
      ...(typeof sharedCwd === "string" ? { cwd: sharedCwd } : {}),
      terminals: terminals.map((terminal) => {
        if (!isRecord(terminal)) return terminal;
        return omitEmpty({
          id: terminal.id,
          name: terminal.name,
          cwd: typeof sharedCwd === "string" ? undefined : terminal.cwd,
        });
      }),
    };
  },
};
