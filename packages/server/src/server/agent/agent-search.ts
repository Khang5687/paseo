import type { AgentSnapshotPayload } from "../messages.js";
import { isSameOrDescendantPath } from "../path-utils.js";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent-storage.js";

/** Newest agents a search reads; older ones need a narrower filter. */
export const AGENT_SEARCH_SCAN_LIMIT = 2000;

export type AgentSearchField = "title" | "labels" | "firstUserMessage" | "lastAssistantMessage";

// Ordered by weight. A word found in the title says more about the thread than the
// same word somewhere in its last reply.
const FIELDS: readonly { field: AgentSearchField; weight: number }[] = [
  { field: "title", weight: 8 },
  { field: "labels", weight: 4 },
  { field: "firstUserMessage", weight: 2 },
  { field: "lastAssistantMessage", weight: 1 },
];

const SNIPPET_CHARS = 160;
const SNIPPET_LEAD_CHARS = 60;

export type AgentSearchText = Partial<Record<AgentSearchField, string | null>>;

export interface AgentSearchTextMatch {
  score: number;
  matchedFields: AgentSearchField[];
  snippet: { field: AgentSearchField; text: string };
}

export interface AgentSearchMatch extends AgentSearchTextMatch {
  agent: AgentSnapshotPayload;
}

export interface AgentSearchResult {
  matches: AgentSearchMatch[];
  scanned: number;
  truncated: boolean;
}

export interface AgentSearchSource {
  manager: Pick<AgentManager, "listAgents" | "getSearchableMessages">;
  storage: Pick<AgentStorage, "list">;
  projectLive(agent: ManagedAgent): Promise<AgentSnapshotPayload>;
  projectStored(record: StoredAgentRecord): AgentSnapshotPayload;
}

export interface AgentSearchOptions {
  query: string;
  includeArchived: boolean;
  cwd?: string;
  workspaceId?: string;
  provider?: string;
  sinceHours?: number;
  limit: number;
  scanLimit?: number;
  now?: number;
}

interface Candidate {
  id: string;
  updatedAt: number;
  live: ManagedAgent | null;
  record: StoredAgentRecord | null;
}

export function tokenizeAgentSearchQuery(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
}

function buildSnippet(text: string, lower: string, tokens: readonly string[]): string {
  const phraseIndex = tokens.length > 1 ? lower.indexOf(tokens.join(" ")) : -1;
  const anchor =
    phraseIndex >= 0
      ? phraseIndex
      : Math.min(
          ...tokens.map((token) => lower.indexOf(token)).filter((index) => index >= 0),
          text.length,
        );
  const start = Math.max(0, Math.min(anchor - SNIPPET_LEAD_CHARS, text.length - SNIPPET_CHARS));
  const end = Math.min(text.length, start + SNIPPET_CHARS);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/**
 * Score one agent's text against the query words. Every word must appear in some
 * field. Each word scores the weight of the best field holding it; a field holding
 * every word, and a field holding the words as one phrase, add bonuses.
 */
export function matchAgentSearchText(
  text: AgentSearchText,
  tokens: readonly string[],
): AgentSearchTextMatch | null {
  if (tokens.length === 0) return null;
  const fields = FIELDS.flatMap(({ field, weight }) => {
    const value = text[field];
    if (!value) return [];
    // Collapsed whitespace lets a multi-word query match across line breaks as a phrase.
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized ? [{ field, weight, text: normalized, lower: normalized.toLowerCase() }] : [];
  });

  let score = 0;
  const matched = new Set<AgentSearchField>();
  for (const token of tokens) {
    const holders = fields.filter((entry) => entry.lower.includes(token));
    if (holders.length === 0) return null;
    for (const holder of holders) matched.add(holder.field);
    score += holders[0]!.weight;
  }

  const counts = fields.map((entry) => ({
    entry,
    count: tokens.filter((token) => entry.lower.includes(token)).length,
  }));
  const complete = counts.find(({ count }) => count === tokens.length)?.entry;
  if (complete) score += complete.weight;
  if (tokens.length > 1) {
    const phrase = tokens.join(" ");
    const phraseHolder = fields.find((entry) => entry.lower.includes(phrase));
    if (phraseHolder) score += phraseHolder.weight * 2;
  }

  const snippetEntry =
    complete ??
    counts.reduce((best, current) => (current.count > best.count ? current : best)).entry;
  return {
    score,
    matchedFields: FIELDS.map(({ field }) => field).filter((field) => matched.has(field)),
    snippet: {
      field: snippetEntry.field,
      text: buildSnippet(snippetEntry.text, snippetEntry.lower, tokens),
    },
  };
}

function formatLabels(labels: Record<string, string> | undefined): string | null {
  const entries = Object.entries(labels ?? {});
  return entries.length > 0 ? entries.map(([key, value]) => `${key}=${value}`).join(" ") : null;
}

function candidateText(source: AgentSearchSource, candidate: Candidate): AgentSearchText {
  const messages = source.manager.getSearchableMessages(candidate.id);
  return {
    title: candidate.record?.title ?? candidate.live?.config.title ?? null,
    labels: formatLabels(candidate.live?.labels ?? candidate.record?.labels),
    firstUserMessage: messages?.firstUserMessage ?? candidate.record?.firstUserMessage ?? null,
    lastAssistantMessage:
      messages?.lastAssistantMessage ?? candidate.record?.lastAssistantMessage ?? null,
  };
}

/**
 * Find agents by what they were about. Reads stored records and in-memory timelines
 * only: it never loads a provider runtime or fetches history from a provider.
 */
export async function searchAgents(
  source: AgentSearchSource,
  options: AgentSearchOptions,
): Promise<AgentSearchResult> {
  const tokens = tokenizeAgentSearchQuery(options.query);
  const scanLimit = options.scanLimit ?? AGENT_SEARCH_SCAN_LIMIT;
  const now = options.now ?? Date.now();
  const since = options.sinceHours !== undefined ? now - options.sinceHours * 60 * 60 * 1000 : null;

  const records = await source.storage.list();
  const recordsById = new Map(records.map((record) => [record.id, record]));
  const live = source.manager.listAgents().filter((agent) => !agent.internal);
  const liveIds = new Set(live.map((agent) => agent.id));
  const candidates: Candidate[] = [
    ...live.map((agent) => ({
      id: agent.id,
      updatedAt: agent.updatedAt.getTime(),
      live: agent,
      record: recordsById.get(agent.id) ?? null,
    })),
    ...records
      .filter((record) => !record.internal && !liveIds.has(record.id))
      .map((record) => ({
        id: record.id,
        updatedAt: Date.parse(record.updatedAt),
        live: null,
        record,
      })),
  ].filter((candidate) => {
    const agent = candidate.live ?? candidate.record!;
    if (!options.includeArchived && candidate.record?.archivedAt) return false;
    if (options.workspaceId && agent.workspaceId !== options.workspaceId) return false;
    if (options.provider && agent.provider !== options.provider) return false;
    if (options.cwd && !isSameOrDescendantPath(options.cwd, agent.cwd)) return false;
    return since === null || candidate.updatedAt >= since;
  });

  candidates.sort((left, right) => right.updatedAt - left.updatedAt);
  const scanned = candidates.slice(0, scanLimit);
  const ranked = scanned
    .flatMap((candidate) => {
      const match = matchAgentSearchText(candidateText(source, candidate), tokens);
      return match ? [{ candidate, match }] : [];
    })
    .sort(
      (left, right) =>
        right.match.score - left.match.score ||
        right.candidate.updatedAt - left.candidate.updatedAt,
    )
    .slice(0, options.limit);

  const matches = await Promise.all(
    ranked.map(async ({ candidate, match }) => ({
      score: match.score,
      matchedFields: match.matchedFields,
      snippet: match.snippet,
      agent: candidate.live
        ? await source.projectLive(candidate.live)
        : source.projectStored(candidate.record!),
    })),
  );
  return { matches, scanned: scanned.length, truncated: candidates.length > scanLimit };
}

/** The row search_agents returns for one match, whether the search ran here or on a connected host. */
export function toAgentSearchResult({
  agent,
  matchedFields,
  snippet,
}: Pick<AgentSearchMatch, "agent" | "matchedFields" | "snippet">) {
  return {
    agentId: agent.id,
    title: agent.title,
    status: agent.status,
    archivedAt: agent.archivedAt ?? null,
    workspaceId: agent.workspaceId ?? null,
    cwd: agent.cwd,
    provider: agent.provider,
    model: agent.model,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
    matchedFields,
    snippet,
  };
}
