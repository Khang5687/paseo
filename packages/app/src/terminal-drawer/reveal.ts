import { queryClient } from "@/data/query-client";
import {
  buildTerminalsQueryKey,
  type ListTerminalsPayload,
} from "@/screens/workspace/terminals/state";
import { useSessionStore } from "@/stores/session-store";
import { selectWorkspaceDirectory } from "@/stores/session-store-hooks/selectors";
import { buildChatDrawerKey } from "./model";
import { useTerminalDrawerStore } from "./store";

/**
 * Opens a chat's drawer on one of its terminals, such as a Run card's. Returns false when the
 * host's list does not put the terminal in that chat's drawer (it was popped out, or the list
 * has not loaded), so the caller can open it as a workspace tab instead.
 */
export function revealChatDrawerTerminal(input: {
  serverId: string;
  workspaceId: string;
  agentId: string;
  terminalId: string;
}): boolean {
  const { serverId, workspaceId, agentId, terminalId } = input;
  const workspaceDirectory = selectWorkspaceDirectory(
    useSessionStore.getState(),
    serverId,
    workspaceId,
  );
  const list = queryClient.getQueryData<ListTerminalsPayload>(
    buildTerminalsQueryKey(serverId, workspaceDirectory, workspaceId),
  );
  const terminal = list?.terminals.find((entry) => entry.id === terminalId);
  if (terminal?.ownerAgentId !== agentId) return false;

  const key = buildChatDrawerKey(serverId, agentId);
  const { chats, updateChat, requestFocus } = useTerminalDrawerStore.getState();
  const phoneSnap = chats[key]?.phoneSnap;
  // A folded or hidden phone sheet would still hide the terminal; open it to half height.
  updateChat(key, {
    open: true,
    activeTerminalId: terminalId,
    ...(phoneSnap === "bar" || phoneSnap === "chat" ? { phoneSnap: "half" } : {}),
  });
  requestFocus(key);
  return true;
}
