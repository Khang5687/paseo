import { useShallow } from "zustand/shallow";
import { useCreateFlowStore, type PendingCreateAttempt } from "@/stores/create-flow-store";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import type { WorkspaceAgentActivity } from "@/utils/workspace-agent-activity";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-identity";

/** What a workspace waits on while nothing in it works and nothing is for you. */
export type WorkspaceWait = NonNullable<WorkspaceDescriptor["waiting"]>;

interface EffectiveWorkspaceStatus {
  status: WorkspaceDescriptor["status"];
  enteredAt: Date | null;
  /** Set while the status is running only because the workspace waits: an hourglass, no ring. */
  waiting: WorkspaceWait | null;
}

export function deriveEffectiveWorkspaceStatus(input: {
  serverId: string;
  workspace: WorkspaceDescriptor;
  pendingCreateAttempts?: Record<string, PendingCreateAttempt>;
  workspaceAgentActivity?: ReadonlyMap<string, WorkspaceAgentActivity>;
}): EffectiveWorkspaceStatus {
  const { workspace } = input;
  const waiting = workspace.waiting ?? null;
  // The host says the workspace waits: running for jobs, or done/attention while subagents run.
  // Both read as running, and the wait says it is not the chat's own turn.
  if (workspace.status === "running" || (workspace.status === "attention" && waiting)) {
    return { status: "running", enteredAt: workspace.statusEnteredAt, waiting };
  }
  if (workspace.status !== "done") {
    return { status: workspace.status, enteredAt: workspace.statusEnteredAt, waiting: null };
  }

  const pendingStartedAt = getPendingInitialAgentCreateStartedAt({
    serverId: input.serverId,
    workspaceId: workspace.id,
    pendingCreateAttempts: input.pendingCreateAttempts,
  });
  if (pendingStartedAt) {
    return { status: "running", enteredAt: pendingStartedAt, waiting: null };
  }

  const rootAgentActivity = input.workspaceAgentActivity?.get(workspace.id);
  if (rootAgentActivity && rootAgentActivity.status !== "done") {
    return {
      status: rootAgentActivity.status,
      enteredAt: rootAgentActivity.enteredAt,
      waiting: null,
    };
  }
  if (waiting) {
    return { status: "running", enteredAt: workspace.statusEnteredAt, waiting };
  }

  return { status: workspace.status, enteredAt: workspace.statusEnteredAt, waiting: null };
}

function getPendingInitialAgentCreateStartedAt(input: {
  serverId: string;
  workspaceId: string;
  pendingCreateAttempts: Record<string, PendingCreateAttempt> | undefined;
}): Date | null {
  let latestStartedAt: Date | null = null;
  for (const pending of Object.values(input.pendingCreateAttempts ?? {})) {
    if (pending.serverId !== input.serverId) continue;
    if (pending.workspaceId !== input.workspaceId) continue;
    if (pending.lifecycle === "abandoned") continue;
    const startedAt = new Date(pending.timestamp);
    if (!latestStartedAt || startedAt > latestStartedAt) {
      latestStartedAt = startedAt;
    }
  }
  return latestStartedAt;
}

export function useWorkspaceStatus(serverId: string, workspaceId: string) {
  const pendingCreateAttempts = useCreateFlowStore((state) => state.pendingByDraftId);
  return useSessionStore(
    useShallow((state) => {
      const session = state.sessions[serverId];
      if (!session) return null;
      const key = resolveWorkspaceMapKeyByIdentity({ workspaces: session.workspaces, workspaceId });
      const workspace = key ? session.workspaces.get(key) : null;
      if (!workspace) return null;
      return deriveEffectiveWorkspaceStatus({
        serverId,
        workspace,
        pendingCreateAttempts,
        workspaceAgentActivity: session.workspaceAgentActivity,
      }).status;
    }),
  );
}
