import { useShallow } from "zustand/shallow";
import { useDraftStore } from "@/stores/draft-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { collectWorkspaceDraftKeys, isUnsentDraft } from "@/stores/workspace-unsent-draft";

/**
 * Whether any chat tab open in the workspace holds a prompt the user has not sent. Drafts
 * live only on this client, so the daemon's workspace status cannot report them.
 */
export function useWorkspaceHasUnsentDraft(input: {
  serverId: string;
  workspaceKey: string;
}): boolean {
  const { serverId, workspaceKey } = input;
  const draftKeys = useWorkspaceLayoutStore(
    useShallow((state) =>
      collectWorkspaceDraftKeys(serverId, state.layoutByWorkspace[workspaceKey]),
    ),
  );
  return useDraftStore((state) =>
    draftKeys.some((draftKey) => isUnsentDraft(state.drafts[draftKey])),
  );
}
