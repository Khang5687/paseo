import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { agentCommandsQueryKey, type AgentCommandsDraftConfig } from "@/hooks/agent-commands-query";

// Commands change on disk (new skills, edited prompt files) without any daemon event, so the
// list revalidates each time the command menu opens after this long. Cached rows stay visible
// while the refetch runs.
const COMMANDS_STALE_TIME = 10_000;
// A query that matches nothing may be looking for a command that landed after the last fetch.
// Refetch for it only when the cached list is older than this, so typing does not refetch per key.
const MISS_REVALIDATE_MIN_AGE = 3_000;

export interface AgentSlashCommand {
  name: string;
  description: string;
  argumentHint: string;
  kind?: string;
}

export type DraftCommandConfig = AgentCommandsDraftConfig;

/** What a draft composer can list commands for, before an agent exists. */
export type DraftCommandTarget =
  | { status: "ready"; config: DraftCommandConfig }
  | { status: "needs-project" }
  | { status: "needs-provider" };

interface ListAgentCommandsOptions {
  agentId: string;
  draftConfig?: DraftCommandConfig;
}

export interface AgentCommandsClient {
  listCommands(options: ListAgentCommandsOptions): ReturnType<DaemonClient["listCommands"]>;
}

export async function fetchAgentCommands(input: {
  client: AgentCommandsClient;
  agentId: string;
  draftConfig?: DraftCommandConfig;
}): Promise<AgentSlashCommand[]> {
  const response = await input.client.listCommands({
    agentId: input.agentId,
    draftConfig: input.draftConfig,
  });
  return response.commands as AgentSlashCommand[];
}

interface UseAgentCommandsQueryOptions {
  serverId: string;
  agentId: string;
  enabled?: boolean;
  draftConfig?: DraftCommandConfig;
}

export function useAgentCommandsQuery({
  serverId,
  agentId,
  enabled = true,
  draftConfig,
}: UseAgentCommandsQueryOptions) {
  const { t } = useTranslation();
  const retainedPanelActive = useRetainedPanelActive();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const queryEnabled =
    enabled && retainedPanelActive && !!client && isConnected && (!!agentId || !!draftConfig);

  const query = useQuery({
    queryKey: agentCommandsQueryKey({ serverId, agentId, draftConfig }),
    queryFn: async () => {
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      return fetchAgentCommands({ client, agentId, draftConfig });
    },
    enabled: queryEnabled,
    staleTime: COMMANDS_STALE_TIME,
    retry: 3,
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 5000),
  });

  // isPending is true when the query has never run yet (no cached data and not fetching)
  // isLoading is true when fetching and no data yet
  const isLoading = query.isPending || query.isLoading;
  const { refetch, isFetching, dataUpdatedAt } = query;

  const revalidateForMiss = useCallback(() => {
    if (!queryEnabled || isFetching || Date.now() - dataUpdatedAt < MISS_REVALIDATE_MIN_AGE) {
      return;
    }
    void refetch();
  }, [queryEnabled, isFetching, dataUpdatedAt, refetch]);

  return {
    commands: query.data ?? [],
    isLoading,
    isFetching,
    // A failed background refetch keeps the cached list; only a failed first load is an error.
    isError: query.isLoadingError,
    error: query.isLoadingError ? query.error : null,
    revalidateForMiss,
  };
}
