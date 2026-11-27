import { useMemo } from "react";
import { usePluginNeedsYouCount } from "@/plugins/needs-you-items";
import { useSessionStore } from "@/stores/session-store";
import { countNeedsYouChats, listNeedsYouChats, type NeedsYouChat } from "./model";

/** The rail's Needs you number: waiting chats on every host, plus what plugins count. */
export function useNeedsYouCount(): number {
  const chats = useSessionStore((state) => countNeedsYouChats(state.sessions));
  return chats + usePluginNeedsYouCount();
}

/** Every waiting chat, oldest first. Recomputed on any session change; mount it only on the page. */
export function useNeedsYouChats(): NeedsYouChat[] {
  const sessions = useSessionStore((state) => state.sessions);
  return useMemo(() => listNeedsYouChats(sessions), [sessions]);
}
