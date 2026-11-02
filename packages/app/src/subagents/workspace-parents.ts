import type { Agent } from "@/stores/session-store";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";

type WorkspaceParentAgent = Pick<Agent, "id" | "workspaceId" | "parentAgentId" | "archivedAt">;

/**
 * Maps a subagent workspace to the workspace that spawned it: child workspaceId → parent
 * workspaceId.
 *
 * Workspace W is a child of P when every unarchived agent rooted in W was spawned by an unarchived
 * agent living in P. Agents whose parent is in W itself are W's own helpers and do not vote; one
 * root agent, or one subagent of a third workspace, keeps W at the top level. Ownership is the
 * agent's `workspaceId`, never its `cwd`.
 */
export function buildWorkspaceParentIndex(
  agents: ReadonlyMap<string, WorkspaceParentAgent>,
  previous?: ReadonlyMap<string, string>,
): Map<string, string> {
  // null marks a workspace that has a root agent or agents of more than one parent workspace.
  const parentByWorkspaceId = new Map<string, string | null>();

  for (const agent of agents.values()) {
    const workspaceId = normalizeWorkspaceOpaqueId(agent.workspaceId);
    if (agent.archivedAt || !workspaceId || parentByWorkspaceId.get(workspaceId) === null) {
      continue;
    }
    const parentWorkspaceId = resolveParentWorkspaceId(agent, agents);
    if (parentWorkspaceId === workspaceId) {
      continue;
    }
    const recorded = parentByWorkspaceId.get(workspaceId);
    const conflicts = recorded !== undefined && recorded !== parentWorkspaceId;
    parentByWorkspaceId.set(workspaceId, conflicts ? null : parentWorkspaceId);
  }

  const index = new Map<string, string>();
  for (const [workspaceId, parentWorkspaceId] of parentByWorkspaceId) {
    if (parentWorkspaceId) {
      index.set(workspaceId, parentWorkspaceId);
    }
  }

  if (previous && areWorkspaceParentIndexesEqual(previous, index)) {
    return previous instanceof Map ? previous : new Map(previous);
  }
  return index;
}

/** The workspace of the agent's live parent, or null when the agent stands on its own. */
function resolveParentWorkspaceId(
  agent: WorkspaceParentAgent,
  agents: ReadonlyMap<string, WorkspaceParentAgent>,
): string | null {
  const parent = agent.parentAgentId ? agents.get(agent.parentAgentId) : undefined;
  if (!parent || parent.archivedAt) {
    return null;
  }
  return normalizeWorkspaceOpaqueId(parent.workspaceId);
}

function areWorkspaceParentIndexesEqual(
  previous: ReadonlyMap<string, string>,
  next: ReadonlyMap<string, string>,
): boolean {
  if (previous.size !== next.size) {
    return false;
  }
  for (const [workspaceId, parentWorkspaceId] of next) {
    if (previous.get(workspaceId) !== parentWorkspaceId) {
      return false;
    }
  }
  return true;
}
