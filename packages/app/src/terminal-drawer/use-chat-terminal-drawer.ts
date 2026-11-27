import { useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/contexts/toast-context";
import { useSessionStore } from "@/stores/session-store";
import {
  buildChatDrawerKey,
  neighborDrawerTerminalId,
  resolveActiveDrawerTerminalId,
  type PhoneDrawerSnap,
} from "./model";
import { useChatDrawerView, useTerminalDrawerStore, type ChatDrawerView } from "./store";
import { useChatTerminals, type ChatTerminals } from "./use-chat-terminals";

export interface ChatTerminalDrawer {
  key: string;
  view: ChatDrawerView;
  chat: ChatTerminals;
  activeTerminalId: string | null;
  /** Shows the drawer, starting a terminal when the chat has none, and asks for focus. */
  show: () => void;
  hide: () => void;
  select: (terminalId: string) => void;
  selectNeighbor: (delta: 1 | -1) => void;
  addTerminal: () => void;
  closeTerminal: (terminalId: string) => void;
  /** Moves the terminal out of the drawer into a workspace tab. */
  popOut: (terminalId: string, openTab: (terminalId: string) => void) => Promise<void>;
  setPhoneSnap: (snap: PhoneDrawerSnap) => void;
  setMaximized: (maximized: boolean) => void;
}

/**
 * Drawer keys with a create in flight, from the moment it starts until its terminal shows in the
 * list, so the empty-drawer rule never closes a drawer about to get its first terminal. Shared at
 * module level because the header toggle and the drawer each run this hook for the same chat.
 */
const awaitingTerminal = new Set<string>();

/** One chat's drawer: the host's terminals for the chat plus how this device shows them. */
export function useChatTerminalDrawer(input: {
  serverId: string;
  workspaceId: string;
  agentId: string;
}): ChatTerminalDrawer {
  const { serverId, workspaceId, agentId } = input;
  const { t } = useTranslation();
  const toast = useToast();
  const key = buildChatDrawerKey(serverId, agentId);
  const view = useChatDrawerView(key);
  const updateChat = useTerminalDrawerStore((state) => state.updateChat);
  const requestFocus = useTerminalDrawerStore((state) => state.requestFocus);
  const agentCwd = useSessionStore(
    (state) => state.sessions[serverId]?.agents.get(agentId)?.cwd ?? null,
  );
  const chat = useChatTerminals({ serverId, workspaceId, agentId, agentCwd });
  const { terminals, create, kill } = chat;
  const activeTerminalId = resolveActiveDrawerTerminalId(terminals, view.activeTerminalId);

  const startTerminal = useCallback(async () => {
    awaitingTerminal.add(key);
    try {
      const terminalId = await create();
      updateChat(key, { activeTerminalId: terminalId });
    } catch (error) {
      awaitingTerminal.delete(key);
      toast.error(error instanceof Error ? error.message : t("terminalDrawer.createFailed"));
    }
  }, [create, key, t, toast, updateChat]);

  const show = useCallback(() => {
    updateChat(key, { open: true, phoneSnap: "half" });
    requestFocus(key);
    if (chat.loaded && terminals.length === 0 && !chat.isCreating) void startTerminal();
  }, [
    chat.isCreating,
    chat.loaded,
    key,
    requestFocus,
    startTerminal,
    terminals.length,
    updateChat,
  ]);

  const hide = useCallback(
    () => updateChat(key, { open: false, maximized: false }),
    [key, updateChat],
  );

  // Like VS Code, the drawer closes when its last shell exits, from `exit` or from another device.
  const isEmpty = chat.loaded && terminals.length === 0;
  useEffect(() => {
    if (!isEmpty) {
      awaitingTerminal.delete(key);
      return;
    }
    if (view.open && !awaitingTerminal.has(key)) hide();
  }, [hide, isEmpty, key, view.open]);

  const select = useCallback(
    (terminalId: string) => {
      updateChat(key, { activeTerminalId: terminalId });
      requestFocus(key);
    },
    [key, requestFocus, updateChat],
  );

  const selectNeighbor = useCallback(
    (delta: 1 | -1) => {
      const next = neighborDrawerTerminalId(terminals, activeTerminalId, delta);
      if (next) updateChat(key, { activeTerminalId: next });
    },
    [activeTerminalId, key, terminals, updateChat],
  );

  const addTerminal = useCallback(() => {
    requestFocus(key);
    void startTerminal();
  }, [key, requestFocus, startTerminal]);

  const closeTerminal = useCallback(
    (terminalId: string) => {
      const remaining = terminals.filter((terminal) => terminal.id !== terminalId);
      // VS Code hides the panel with its last terminal; the next show starts a fresh one.
      updateChat(key, {
        activeTerminalId:
          terminalId === activeTerminalId
            ? (neighborDrawerTerminalId(terminals, terminalId, -1) ?? remaining[0]?.id ?? null)
            : activeTerminalId,
        ...(remaining.length === 0 ? { open: false, maximized: false } : {}),
      });
      kill(terminalId).catch(() => undefined);
    },
    [activeTerminalId, key, kill, terminals, updateChat],
  );

  const { popOut: popOutTerminal } = chat;
  const popOut = useCallback(
    async (terminalId: string, openTab: (terminalId: string) => void) => {
      const remaining = terminals.filter((terminal) => terminal.id !== terminalId);
      const moved = await popOutTerminal(terminalId).catch(() => false);
      if (!moved) {
        toast.error(t("terminalDrawer.popOutFailed"));
        return;
      }
      if (remaining.length === 0) updateChat(key, { open: false, maximized: false });
      openTab(terminalId);
    },
    [key, popOutTerminal, t, terminals, toast, updateChat],
  );

  const setPhoneSnap = useCallback(
    (snap: PhoneDrawerSnap) => updateChat(key, { phoneSnap: snap }),
    [key, updateChat],
  );
  const setMaximized = useCallback(
    (maximized: boolean) => updateChat(key, { maximized }),
    [key, updateChat],
  );

  return useMemo(
    () => ({
      key,
      view,
      chat,
      activeTerminalId,
      show,
      hide,
      select,
      selectNeighbor,
      addTerminal,
      closeTerminal,
      popOut,
      setPhoneSnap,
      setMaximized,
    }),
    [
      activeTerminalId,
      addTerminal,
      chat,
      closeTerminal,
      hide,
      key,
      popOut,
      select,
      selectNeighbor,
      setMaximized,
      setPhoneSnap,
      show,
      view,
    ],
  );
}
