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

/** One row in a thread's subagent tree, in display order (a parent sits right above its children). */
export interface ThreadChildNode {
  row: SubagentRow;
  /** Nesting under the thread's own agents: 0 for a child of a root agent or an orphan. */
  depth: number;
}

/** A same-workspace agent as the tree needs it: its row and the agent that spawned it. */
export interface ThreadChildEntry {
  row: SubagentRow;
  parentAgentId: string | null;
}

/**
 * The child rows under one sidebar thread as a tree: each same-workspace agent sits under the agent
 * that spawned it, and each provider subagent under the agent that owns it. A row whose parent is
 * not itself a row here (a root agent, archived, another workspace) starts at depth 0, so nothing
 * is hidden. Siblings are oldest first. Output is the pre-order walk, so the list renders flat.
 */
export function buildThreadChildTree(input: {
  children: readonly ThreadChildEntry[];
  providerRows: readonly ProviderSubagentRow[];
}): ThreadChildNode[] {
  const entries: ThreadChildEntry[] = [
    ...input.children,
    ...input.providerRows.map((row) => ({ row, parentAgentId: row.parentAgentId })),
  ];
  const rowIds = new Set(input.children.map((entry) => entry.row.id));
  const byParent = new Map<string | null, ThreadChildEntry[]>();
  for (const entry of entries) {
    const parentKey =
      entry.parentAgentId !== null &&
      entry.parentAgentId !== entry.row.id &&
      rowIds.has(entry.parentAgentId)
        ? entry.parentAgentId
        : null;
    const siblings = byParent.get(parentKey);
    if (siblings) siblings.push(entry);
    else byParent.set(parentKey, [entry]);
  }
  for (const siblings of byParent.values()) {
    siblings.sort((left, right) => left.row.createdAt.getTime() - right.row.createdAt.getTime());
  }

  const nodes: ThreadChildNode[] = [];
  const visited = new Set<SubagentRow>();
  const walk = (parentKey: string | null, depth: number) => {
    for (const entry of byParent.get(parentKey) ?? []) {
      if (visited.has(entry.row)) continue;
      visited.add(entry.row);
      nodes.push({ row: entry.row, depth });
      // Only a Paseo agent can own children; a provider row's id may collide with an agent id.
      if (entry.row.kind === "paseo") walk(entry.row.id, depth + 1);
    }
  };
  walk(null, 0);
  // A parent cycle never reaches the walk from the top. Surface those rows rather than lose them.
  for (const entry of entries) {
    if (!visited.has(entry.row)) {
      visited.add(entry.row);
      nodes.push({ row: entry.row, depth: 0 });
      if (entry.row.kind === "paseo") walk(entry.row.id, 1);
    }
  }
  return nodes;
}
