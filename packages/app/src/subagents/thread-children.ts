import type { Agent } from "@/stores/session-store";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";
import { isWorkspaceRootAgent } from "./workspace-root-policy";
// Type-only: the session store builds its index from this module, and select.ts imports the store.
import type { ProviderSubagentRow, SubagentRow } from "./select";

type ThreadAgent = Pick<Agent, "id" | "workspaceId" | "parentAgentId" | "archivedAt" | "createdAt">;

export interface ThreadAgents<A extends ThreadAgent = Agent> {
  /** Every unarchived agent in the workspace. Provider subagents hang off any of them. */
  agentIds: string[];
  /**
   * Same-workspace descendants, oldest first: the agents whose own sidebar row would otherwise be
   * nothing, because they share their parent's workspace row. Cross-workspace children are not
   * here; their workspace nests under this one as a row of its own.
   */
  children: A[];
}

/**
 * Workspace id → the agents that live inside that workspace's sidebar row.
 *
 * Membership uses the same root rule as workspace status (`isWorkspaceRootAgent`), so a child row
 * here is exactly an agent whose state does not get a sidebar row of its own. Entries whose agents
 * did not change keep their identity, so a stream tick on an unrelated agent re-renders no row.
 */
export function buildThreadAgentIndex<A extends ThreadAgent>(
  agents: ReadonlyMap<string, A>,
  previous?: ReadonlyMap<string, ThreadAgents<A>>,
): Map<string, ThreadAgents<A>> {
  const index = new Map<string, ThreadAgents<A>>();
  for (const agent of agents.values()) {
    const workspaceId = normalizeWorkspaceOpaqueId(agent.workspaceId);
    if (agent.archivedAt || !workspaceId) continue;
    let entry = index.get(workspaceId);
    if (!entry) {
      entry = { agentIds: [], children: [] };
      index.set(workspaceId, entry);
    }
    entry.agentIds.push(agent.id);
    const parent = agent.parentAgentId ? agents.get(agent.parentAgentId) : undefined;
    if (!isWorkspaceRootAgent(agent, parent)) entry.children.push(agent);
  }

  let unchanged = previous?.size === index.size;
  for (const [workspaceId, entry] of index) {
    entry.children.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
    const previousEntry = previous?.get(workspaceId);
    if (previousEntry && areThreadAgentsIdentical(previousEntry, entry)) {
      index.set(workspaceId, previousEntry);
    } else {
      unchanged = false;
    }
  }
  if (previous && unchanged) {
    return previous instanceof Map ? previous : new Map(previous);
  }
  return index;
}

function areThreadAgentsIdentical<A extends ThreadAgent>(
  previous: ThreadAgents<A>,
  next: ThreadAgents<A>,
): boolean {
  return (
    previous.agentIds.length === next.agentIds.length &&
    previous.children.length === next.children.length &&
    previous.agentIds.every((id, index) => next.agentIds[index] === id) &&
    previous.children.every((agent, index) => next.children[index] === agent)
  );
}

/**
 * The agent a thread row stands for when its id is copied: the most recently active root agent.
 * Same-workspace subagents are the row's children, so they are never picked here. `rootCount`
 * lets the caller say the pick was a choice among several.
 */
export function pickThreadRootAgent<A extends ThreadAgent>(
  thread: ThreadAgents<A> | undefined,
  agents: ReadonlyMap<string, { id: string; lastActivityAt: Date }>,
): { agentId: string; rootCount: number } | null {
  if (!thread) return null;
  const childIds = new Set(thread.children.map((child) => child.id));
  let picked: { id: string; lastActivityAt: Date } | null = null;
  let rootCount = 0;
  for (const id of thread.agentIds) {
    const agent = agents.get(id);
    if (!agent || childIds.has(id)) continue;
    rootCount += 1;
    if (!picked || agent.lastActivityAt.getTime() > picked.lastActivityAt.getTime()) picked = agent;
  }
  return picked ? { agentId: picked.id, rootCount } : null;
}

/** The child rows under one sidebar thread: its same-workspace agents and provider subagents. */
export function buildThreadChildRows(input: {
  children: readonly SubagentRow[];
  providerRows: readonly ProviderSubagentRow[];
}): SubagentRow[] {
  const rows = [...input.children, ...input.providerRows];
  rows.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
  return rows;
}
