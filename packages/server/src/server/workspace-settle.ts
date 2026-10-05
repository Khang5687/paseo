import type { Logger } from "pino";

import type { AgentManager } from "./agent/agent-manager.js";
import type { WorkspaceRegistry } from "./workspace-registry.js";

/**
 * A settled workspace returns to the sidebar's main list as soon as any of its
 * agents starts a turn after the settle: a prompt from any client, a schedule,
 * a heartbeat, or an autonomous wake. A turn already running when the user
 * settled does not count. Daemon-global so every client sees one transition.
 */
export function attachWorkspaceAutoUnsettle(input: {
  agentManager: Pick<AgentManager, "subscribe">;
  workspaceRegistry: Pick<WorkspaceRegistry, "get" | "update">;
  logger: Logger;
}): () => void {
  const logger = input.logger.child({ module: "workspace-settle" });
  const pendingWorkspaceIds = new Set<string>();

  const unsettleIfTurnIsNewer = async (workspaceId: string, turnStartedAtMs: number) => {
    const record = await input.workspaceRegistry.get(workspaceId);
    if (!record?.settledAt || record.archivedAt) return;
    if (turnStartedAtMs <= Date.parse(record.settledAt)) return;
    await input.workspaceRegistry.update(workspaceId, (existing) => ({
      ...existing,
      settledAt: null,
      updatedAt: new Date().toISOString(),
    }));
  };

  return input.agentManager.subscribe((event) => {
    if (event.type !== "agent_state") return;
    const { agent } = event;
    const workspaceId = agent.workspaceId;
    const turnStartedAt = agent.activeTurnStartedAt;
    if (agent.internal || !workspaceId || !turnStartedAt) return;
    if (pendingWorkspaceIds.has(workspaceId)) return;
    pendingWorkspaceIds.add(workspaceId);
    void unsettleIfTurnIsNewer(workspaceId, turnStartedAt.getTime())
      .catch((error: unknown) => {
        logger.error({ err: error, workspaceId }, "Failed to unsettle workspace on new turn");
      })
      .finally(() => {
        pendingWorkspaceIds.delete(workspaceId);
      });
  });
}
