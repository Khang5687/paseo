import { getParentAddressFromLabels } from "@getpaseo/protocol/agent-labels";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useArchiveAgent } from "@/hooks/use-archive-agent";
import { useSessionStore } from "@/stores/session-store";
import {
  createArchiveFinishedSubagents,
  type ArchiveFinishedOutcome,
  type ArchiveFinishedState,
  type ArchiveFinishedSubagents,
} from "./archive-finished";
import { useProviderSubagentStore } from "./provider-store";
import type { ProviderSubagentRow, SubagentRow } from "./select";

export type { ArchiveFinishedStatus } from "./archive-finished";

export interface UseArchiveFinishedSubagentsInput {
  serverId: string;
  parentAgentId: string;
  rows: readonly SubagentRow[];
}

export interface UseArchiveFinishedThreadInput {
  serverId: string;
  /** Every same-workspace subagent of the thread, at any depth. */
  agentIds: ReadonlySet<string>;
  /** The thread's whole subagent tree: Paseo rows and provider rows. */
  rows: readonly SubagentRow[];
}

export interface ArchiveFinishedSubagentsCapability extends ArchiveFinishedState {
  archiveFinished: () => Promise<ArchiveFinishedOutcome>;
}

/** Provider rows hide under the agent that owns them, so group them by owner. */
function dismissProviderRows(serverId: string, rows: ProviderSubagentRow[]): void {
  const idsByOwner = new Map<string, string[]>();
  for (const row of rows) {
    const ids = idsByOwner.get(row.parentAgentId);
    if (ids) ids.push(row.id);
    else idsByOwner.set(row.parentAgentId, [row.id]);
  }
  const store = useProviderSubagentStore.getState();
  for (const [owner, ids] of idsByOwner) store.hideFromTrack(serverId, owner, ids);
}

function useArchiveFinishedState(
  archiveFinished: ArchiveFinishedSubagents,
  rows: readonly SubagentRow[],
): ArchiveFinishedSubagentsCapability {
  const state = useSyncExternalStore(
    archiveFinished.subscribe,
    archiveFinished.getState,
    archiveFinished.getState,
  );

  useEffect(() => {
    archiveFinished.setRows(rows);
  }, [archiveFinished, rows]);

  return { ...state, archiveFinished: archiveFinished.archiveFinished };
}

/** Archive finished for one agent's direct children, from its subagent track. */
export function useArchiveFinishedSubagents({
  serverId,
  parentAgentId,
  rows,
}: UseArchiveFinishedSubagentsInput): ArchiveFinishedSubagentsCapability {
  const { archiveAgent } = useArchiveAgent();
  const archiveFinished = useMemo(
    () =>
      createArchiveFinishedSubagents([], {
        isInScope: (agent) => agent.parentAgentId === parentAgentId,
        getManagedSubagent: (address) => {
          const agent = useSessionStore
            .getState()
            .sessions[address.serverId]?.agents.get(address.agentId);
          if (!agent) return undefined;
          const parent = getParentAddressFromLabels(agent.labels, address.serverId);
          if (parent?.serverId !== serverId) return undefined;
          return { ...agent, parentAgentId: parent.agentId };
        },
        archiveManagedSubagent: archiveAgent,
        dismissProviderSubagents: (providerRows) => dismissProviderRows(serverId, providerRows),
      }),
    [archiveAgent, parentAgentId, serverId],
  );
  return useArchiveFinishedState(archiveFinished, rows);
}

/**
 * Archive finished for a whole sidebar thread: every idle or errored Paseo subagent at any depth
 * and every finished provider row. Same engine as the track's; only the scope differs.
 */
export function useArchiveFinishedThread({
  serverId,
  agentIds,
  rows,
}: UseArchiveFinishedThreadInput): ArchiveFinishedSubagentsCapability {
  const { archiveAgent } = useArchiveAgent();
  const archiveFinished = useMemo(
    () =>
      createArchiveFinishedSubagents([], {
        isInScope: (agent) => agentIds.has(agent.id),
        getManagedSubagent: (address) =>
          useSessionStore.getState().sessions[address.serverId]?.agents.get(address.agentId),
        archiveManagedSubagent: archiveAgent,
        dismissProviderSubagents: (providerRows) => dismissProviderRows(serverId, providerRows),
      }),
    [agentIds, archiveAgent, serverId],
  );
  return useArchiveFinishedState(archiveFinished, rows);
}
