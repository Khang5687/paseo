import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import { isWorkspaceRootAgent } from "@/subagents/policies";
import { deriveSidebarStateBucket } from "./sidebar-agent-state";

export interface WorkspaceAgentActivity {
  agentId: string;
  status: WorkspaceDescriptor["status"];
  enteredAt: Date | null;
  /** Earliest scheduled run among the workspace's root agents, whichever agent is latest. */
  nextRunAt: string | null;
}

function workspaceAgentStatus(agent: Agent): Agent["status"] {
  if (agent.turn.phase === "open") return "running";
  return agent.status === "running" ? "idle" : agent.status;
}

/** A visible root agent of its workspace: the agents whose state the workspace row shows. */
function isWorkspaceActivityRoot(
  agent: Agent,
  agents: ReadonlyMap<string, Agent>,
): agent is Agent & { workspaceId: string } {
  const parentAgent = agent.parentAgentId ? agents.get(agent.parentAgentId) : undefined;
  return Boolean(
    !agent.archivedAt &&
    !agent.background &&
    agent.workspaceId &&
    isWorkspaceRootAgent(agent, parentAgent),
  );
}

function keepEarliest(
  byWorkspaceId: Map<string, string>,
  workspaceId: string,
  at: string | undefined,
) {
  const earliest = byWorkspaceId.get(workspaceId);
  if (at && (!earliest || Date.parse(at) < Date.parse(earliest))) {
    byWorkspaceId.set(workspaceId, at);
  }
}

export function buildWorkspaceAgentActivityIndex(
  agents: ReadonlyMap<string, Agent>,
  previous?: ReadonlyMap<string, WorkspaceAgentActivity>,
): Map<string, WorkspaceAgentActivity> {
  const activityByWorkspaceId = new Map<string, WorkspaceAgentActivity>();
  const latestActivityAtByWorkspaceId = new Map<string, Date>();
  const nextRunAtByWorkspaceId = new Map<string, string>();

  for (const agent of agents.values()) {
    if (!isWorkspaceActivityRoot(agent, agents)) continue;
    keepEarliest(nextRunAtByWorkspaceId, agent.workspaceId, agent.backgroundWork?.nextRunAt);

    const enteredAt = agent.attentionTimestamp ?? agent.updatedAt;
    const latestActivityAt = latestActivityAtByWorkspaceId.get(agent.workspaceId);
    if (latestActivityAt && enteredAt <= latestActivityAt) {
      continue;
    }
    latestActivityAtByWorkspaceId.set(agent.workspaceId, enteredAt);

    const status = deriveSidebarStateBucket({
      status: workspaceAgentStatus(agent),
      backgroundWork: agent.backgroundWork,
      pendingPermissionCount: agent.pendingPermissions.length,
      requiresAttention: agent.requiresAttention,
      attentionReason: agent.attentionReason,
    });
    activityByWorkspaceId.set(agent.workspaceId, {
      agentId: agent.id,
      status,
      enteredAt,
      nextRunAt: null,
    });
  }

  for (const [workspaceId, activity] of activityByWorkspaceId) {
    activity.nextRunAt = nextRunAtByWorkspaceId.get(workspaceId) ?? null;
    const previousActivity = previous?.get(workspaceId);
    if (
      previousActivity?.agentId === activity.agentId &&
      previousActivity.status === activity.status &&
      previousActivity.nextRunAt === activity.nextRunAt
    ) {
      activityByWorkspaceId.set(workspaceId, previousActivity);
    }
  }

  if (previous && areWorkspaceAgentActivityIndexesIdentical(previous, activityByWorkspaceId)) {
    return previous instanceof Map ? previous : new Map(previous);
  }
  return activityByWorkspaceId;
}

function areWorkspaceAgentActivityIndexesIdentical(
  previous: ReadonlyMap<string, WorkspaceAgentActivity>,
  next: ReadonlyMap<string, WorkspaceAgentActivity>,
): boolean {
  if (previous.size !== next.size) {
    return false;
  }
  for (const [workspaceId, activity] of next) {
    if (previous.get(workspaceId) !== activity) {
      return false;
    }
  }
  return true;
}
