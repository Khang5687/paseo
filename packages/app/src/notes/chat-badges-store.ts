import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useMemo } from "react";
import { z } from "zod";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";
import { useAppVisible } from "@/hooks/use-app-visible";
import { useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import {
  chatNoteBadge,
  chatNotesKey,
  EMPTY_CHAT_NOTE_BADGE,
  latestNoteFiredAt,
  type ChatNoteBadge,
  type ChatNotesSeen,
} from "./chat-badges";
import type { Note } from "./model";
import { useHostSupportsNotes, useNotesDemand, useNotesStore } from "./store";

/** Enough for every chat a person keeps around; the oldest entries go first. */
const MAX_SEEN_CHATS = 500;

const SeenStateSchema = z.object({
  since: z.string(),
  seenAt: z.record(z.string(), z.string()),
});

interface ChatNotesSeenState extends ChatNotesSeen {
  markSeen: (serverId: string, agentId: string, firedAt: string) => void;
}

/**
 * When the owner last had each chat open with a fired note in it, kept on this device. It clears
 * the sidebar's fired badge; a chat never opened since its note fired keeps the badge.
 */
const useChatNotesSeenStore = create<ChatNotesSeenState>()(
  persist(
    (set) => ({
      since: new Date().toISOString(),
      seenAt: {},
      markSeen: (serverId, agentId, firedAt) =>
        set((state) => {
          // The host's clock stamps the fired time; this device's may run behind it, so the mark
          // is never earlier than the note it covers.
          const now = new Date().toISOString();
          const at = firedAt > now ? firedAt : now;
          const entries = Object.entries({
            ...state.seenAt,
            [chatNotesKey(serverId, agentId)]: at,
          });
          if (entries.length > MAX_SEEN_CHATS) {
            entries.sort((a, b) => b[1].localeCompare(a[1]));
            entries.length = MAX_SEEN_CHATS;
          }
          return { seenAt: Object.fromEntries(entries) };
        }),
    }),
    {
      name: "chat-notes-seen",
      version: 1,
      storage: createValidatedPersistStorage(AsyncStorage, SeenStateSchema),
      partialize: (state) => ({ since: state.since, seenAt: state.seenAt }),
    },
  ),
);

const EMPTY_NOTES: Note[] = [];
const EMPTY_AGENT_IDS: string[] = [];
/**
 * The badge for a row standing for these chats. Reads the notes the app already holds, and
 * re-renders the row only when its counts change, not on every note edit on the host.
 */
export function useChatNoteBadge(serverId: string, agentIds: readonly string[]): ChatNoteBadge {
  const supported = useHostSupportsNotes(serverId);
  const since = useChatNotesSeenStore((state) => state.since);
  const seenAt = useChatNotesSeenStore((state) => state.seenAt);
  const counts = useNotesStore((state) => {
    if (!supported) return "0:0";
    const notes = state.hosts[serverId]?.notes ?? EMPTY_NOTES;
    const badge = chatNoteBadge({ serverId, agentIds, notes, seen: { since, seenAt } });
    return `${badge.waiting}:${badge.fired}`;
  });
  return useMemo(() => {
    const [waiting, fired] = counts.split(":").map(Number);
    return waiting || fired ? { waiting: waiting!, fired: fired! } : EMPTY_CHAT_NOTE_BADGE;
  }, [counts]);
}

/** A thread row stands for every agent in its workspace, sub-agents included. */
export function useWorkspaceNoteBadge(serverId: string, workspaceId: string): ChatNoteBadge {
  const agentIds = useSessionStore(
    (state) => state.sessions[serverId]?.threadAgents.get(workspaceId)?.agentIds ?? EMPTY_AGENT_IDS,
  );
  return useChatNoteBadge(serverId, agentIds);
}

/**
 * Feeds the sidebar's note badges, mounted once at the root. While the app is on screen it holds one
 * notes subscription per host (the daemon pushes changes; nothing polls), and it marks a chat's
 * fired notes seen while that chat is the focused one.
 */
export function ChatNoteBadgesHost(): null {
  const visible = useAppVisible();
  const hosts = useHosts();
  const serverIds = useMemo(
    () => (visible ? hosts.map((host) => host.serverId) : EMPTY_AGENT_IDS),
    [hosts, visible],
  );
  useNotesDemand(serverIds);
  const focusedAgentIds = useSessionStore(
    useShallow((state) =>
      serverIds.map((serverId) => state.sessions[serverId]?.focusedAgentId ?? null),
    ),
  );
  const notesByHost = useNotesStore((state) => state.hosts);
  const since = useChatNotesSeenStore((state) => state.since);
  const seenAt = useChatNotesSeenStore((state) => state.seenAt);

  useEffect(() => {
    serverIds.forEach((serverId, index) => {
      const agentId = focusedAgentIds[index];
      if (!agentId) return;
      const notes = notesByHost[serverId]?.notes ?? EMPTY_NOTES;
      const badge = chatNoteBadge({
        serverId,
        agentIds: [agentId],
        notes,
        seen: { since, seenAt },
      });
      const firedAt = latestNoteFiredAt(notes, agentId);
      if (badge.fired > 0 && firedAt) {
        useChatNotesSeenStore.getState().markSeen(serverId, agentId, firedAt);
      }
    });
  }, [focusedAgentIds, notesByHost, seenAt, serverIds, since]);

  return null;
}
