import { useCallback, useMemo } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { workspaceTerminalsPushRoute } from "@/data/push-router";
import { useReplicaQuery } from "@/data/query";
import { queryClient } from "@/data/query-client";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import {
  buildTerminalsQueryKey,
  removeTerminalFromPayload,
  upsertCreatedTerminalPayload,
  type ListTerminalsPayload,
} from "@/screens/workspace/terminals/state";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import { selectChatTerminals, type DrawerTerminal } from "./model";

export interface ChatTerminals {
  /** The host knows which chat a terminal belongs to. Older hosts have no drawer. */
  supported: boolean;
  ready: boolean;
  /** The host's terminal list has arrived at least once. */
  loaded: boolean;
  workspaceDirectory: string | null;
  terminals: DrawerTerminal[];
  isCreating: boolean;
  create: () => Promise<string | null>;
  kill: (terminalId: string) => Promise<void>;
  /** Hands the terminal to the workspace, which opens it as a tab on every device. */
  popOut: (terminalId: string) => Promise<boolean>;
}

/**
 * One chat's drawer terminals. They come from the workspace terminal list the workspace screen
 * already keeps live, filtered by owner, so the drawer and the tab bar never disagree.
 */
export function useChatTerminals(input: {
  serverId: string;
  workspaceId: string;
  agentId: string;
  agentCwd: string | null;
}): ChatTerminals {
  const { serverId, workspaceId, agentId, agentCwd } = input;
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const supported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.chatTerminals === true,
  );
  const workspaceDirectory = useWorkspaceDirectory(serverId, workspaceId);
  const queryKey = useMemo(
    () => buildTerminalsQueryKey(serverId, workspaceDirectory, workspaceId || null),
    [serverId, workspaceDirectory, workspaceId],
  );
  const ready = Boolean(supported && client && isConnected && workspaceDirectory);
  const paneWorkspaceId = workspaceId || undefined;
  // The same key, push route and request as the workspace screen's list, so both share one entry.
  const query = useReplicaQuery({
    queryKey,
    enabled: ready,
    pushEvent: "terminals_changed",
    meta: workspaceTerminalsPushRoute({
      enabled: ready,
      serverId,
      cwd: workspaceDirectory ?? "",
      ...(paneWorkspaceId ? { workspaceId: paneWorkspaceId } : {}),
    }),
    queryFn: async () => {
      if (!client || !workspaceDirectory) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      return await client.listTerminals(
        workspaceDirectory,
        undefined,
        paneWorkspaceId ? { workspaceId: paneWorkspaceId } : {},
      );
    },
  });
  const terminals = useMemo(
    () => selectChatTerminals(query.data?.terminals ?? [], agentId),
    [agentId, query.data],
  );

  const createMutation = useMutation(
    {
      mutationFn: async () => {
        const cwd = agentCwd || workspaceDirectory;
        if (!client || !cwd) {
          throw new Error(t("workspace.terminal.hostDisconnected"));
        }
        const payload = await client.createTerminal(cwd, undefined, undefined, {
          workspaceId: workspaceId || undefined,
          ownerAgentId: agentId,
        });
        if (!payload.terminal) {
          throw new Error(payload.error ?? t("terminalDrawer.createFailed"));
        }
        return payload.terminal;
      },
      onSuccess: (terminal) => {
        queryClient.setQueryData<ListTerminalsPayload>(queryKey, (current) =>
          upsertCreatedTerminalPayload({ current, terminal, workspaceDirectory }),
        );
      },
    },
    queryClient,
  );
  const { mutateAsync: createAsync, isPending: isCreating } = createMutation;

  const create = useCallback(async () => {
    const terminal = await createAsync();
    return terminal.id;
  }, [createAsync]);

  const kill = useCallback(
    async (terminalId: string) => {
      if (!client) return;
      queryClient.setQueryData<ListTerminalsPayload>(
        queryKey,
        removeTerminalFromPayload(terminalId),
      );
      await client.killTerminal(terminalId);
    },
    [client, queryKey],
  );

  const popOut = useCallback(
    async (terminalId: string) => {
      if (!client) return false;
      const result = await client.setTerminalOwner({ terminalId, ownerAgentId: null });
      if (!result.success) return false;
      queryClient.setQueryData<ListTerminalsPayload>(queryKey, (current) =>
        current
          ? {
              ...current,
              terminals: current.terminals.map((terminal) =>
                terminal.id === terminalId ? { ...terminal, ownerAgentId: undefined } : terminal,
              ),
            }
          : current,
      );
      return true;
    },
    [client, queryKey],
  );

  const loaded = query.data !== undefined;
  return useMemo(
    () => ({
      supported,
      ready,
      loaded,
      workspaceDirectory,
      terminals,
      isCreating,
      create,
      kill,
      popOut,
    }),
    [supported, ready, loaded, workspaceDirectory, terminals, isCreating, create, kill, popOut],
  );
}
