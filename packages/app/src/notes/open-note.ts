import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { useNoteFocusStore } from "./focus-store";
import type { Note } from "./model";

/**
 * Open the chat or terminal a note was made on and ask that view to scroll to the note's text.
 * Returns false when the note's terminal has no workspace to open it in.
 */
export function openNote(serverId: string, note: Note): boolean {
  const { anchor } = note;
  if (anchor.kind === "agent") {
    useNoteFocusStore.getState().focus(serverId, note);
    navigateToAgent({ serverId, agentId: anchor.agentId, pin: true });
    return true;
  }
  if (!anchor.workspaceId) return false;
  useNoteFocusStore.getState().focus(serverId, note);
  navigateToWorkspace({
    serverId,
    workspaceId: anchor.workspaceId,
    target: { kind: "terminal", terminalId: anchor.terminalId },
  });
  return true;
}
