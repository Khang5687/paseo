import type { Agent } from "@/stores/session-store";
import type { ThreadAgents } from "@/subagents/thread-children";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import * as Clipboard from "expo-clipboard";
import { useToast } from "@/contexts/toast-context";
import { useSessionStore } from "@/stores/session-store";
import { pickThreadRootAgent } from "@/subagents/thread-children";

const SHORT_ID_LENGTH = 7;

/**
 * Puts one agent id on the clipboard and toasts "<label> copied". The one implementation behind
 * every "Copy agent ID" action: the workspace tab menu and the sidebar rows.
 */
export function useCopyAgentId(): (agentId: string, label?: string) => Promise<void> {
  const { t } = useTranslation();
  const toast = useToast();
  return useCallback(
    async (agentId, label) => {
      if (!agentId) return;
      try {
        await Clipboard.setStringAsync(agentId);
        toast.copied(label ?? t("workspace.tabs.toasts.agentIdCopiedLabel"));
      } catch {
        toast.error(t("workspace.tabs.toasts.copyFailed"));
      }
    },
    [toast, t],
  );
}

/**
 * The copy action of one sidebar thread row, or undefined while its workspace has no agent. It
 * copies the most recently active root agent and names that agent, and how many it was picked
 * from, in the toast.
 */
export function useCopyThreadAgentId(
  serverId: string | undefined,
  workspaceId: string | undefined,
): (() => void) | undefined {
  const { t } = useTranslation();
  const copyAgentId = useCopyAgentId();
  // Two primitive selectors: the picker's result object is new on every call.
  const agentId = useSessionStore((state) =>
    serverId && workspaceId
      ? pickForThread(state.sessions, serverId, workspaceId)?.agentId
      : undefined,
  );
  const rootCount = useSessionStore((state) =>
    serverId && workspaceId
      ? (pickForThread(state.sessions, serverId, workspaceId)?.rootCount ?? 0)
      : 0,
  );
  const copy = useCallback(() => {
    if (!agentId) return;
    const id = agentId.slice(0, SHORT_ID_LENGTH);
    void copyAgentId(
      agentId,
      rootCount > 1
        ? t("sidebar.workspace.toasts.agentIdCopiedMostRecent", { id, count: rootCount })
        : t("sidebar.workspace.toasts.agentIdCopied", { id }),
    );
  }, [agentId, copyAgentId, rootCount, t]);
  return agentId ? copy : undefined;
}

function pickForThread(
  sessions: Record<string, { threadAgents: Map<string, ThreadAgents>; agents: Map<string, Agent> }>,
  serverId: string,
  workspaceId: string,
) {
  const session = sessions[serverId];
  return pickThreadRootAgent(session?.threadAgents.get(workspaceId), session?.agents ?? EMPTY);
}

const EMPTY: ReadonlyMap<string, Agent> = new Map<string, Agent>();
