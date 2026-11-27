import type { PluginActiveRefs } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import { entityRefs } from "./client-state/refs";

/**
 * The chat open in the app, as plugin refs: its workspace, and its agent when a chat tab has
 * focus. Sidebar views and sidebar items get the same value.
 */
export function usePluginActiveRefs(): PluginActiveRefs {
  const selection = useActiveWorkspaceSelection();
  const serverId = selection?.serverId ?? null;
  const workspaceId = selection?.workspaceId ?? null;
  const focusedAgentId = useSessionStore((state) =>
    serverId ? (state.sessions[serverId]?.focusedAgentId ?? null) : null,
  );
  return useMemo(
    () => ({
      workspace: serverId && workspaceId ? entityRefs.workspace(serverId, workspaceId) : null,
      agent: serverId && focusedAgentId ? entityRefs.agent(serverId, focusedAgentId) : null,
    }),
    [focusedAgentId, serverId, workspaceId],
  );
}
