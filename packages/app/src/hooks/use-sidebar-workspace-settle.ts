import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import { useToast } from "@/contexts/toast-context";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { getHostRuntimeStore } from "@/runtime/host-runtime";

export type SettleableWorkspace = Pick<
  SidebarWorkspaceEntry,
  "serverId" | "workspaceId" | "workspaceKey" | "settledAt"
>;

export type ToggleSidebarWorkspaceSettle = (workspace: SettleableWorkspace) => void;

// Module scope, not a per-hook ref: every row holds its own controller instance (hover button,
// kebab and context menu), and a per-instance guard would let two of them fire concurrent,
// opposite setWorkspaceSettled calls for the same workspace.
const pendingWorkspaceKeys = new Set<string>();

export function useSidebarWorkspaceSettleController(): ToggleSidebarWorkspaceSettle {
  const { t } = useTranslation();
  const toast = useToast();
  const mutation = useMutation({
    mutationFn: async ({
      workspace,
      settled,
    }: {
      workspace: SettleableWorkspace;
      settled: boolean;
    }) => {
      const client = getHostRuntimeStore().getClient(workspace.serverId);
      if (!client) {
        throw new Error(t("sidebar.workspace.toasts.hostDisconnected"));
      }
      await client.setWorkspaceSettled(workspace.workspaceId, settled);
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : t("sidebar.workspace.toasts.hostDisconnected"),
      );
    },
    onSettled: (_data, _error, { workspace }) => {
      pendingWorkspaceKeys.delete(workspace.workspaceKey);
    },
  });
  const mutate = mutation.mutate;

  return useCallback(
    (workspace: SettleableWorkspace) => {
      if (pendingWorkspaceKeys.has(workspace.workspaceKey)) {
        return;
      }
      pendingWorkspaceKeys.add(workspace.workspaceKey);
      mutate({ workspace, settled: workspace.settledAt == null });
    },
    [mutate],
  );
}
