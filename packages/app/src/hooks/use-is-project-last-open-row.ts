import { useIsCompactFormFactor } from "@/constants/layout";
import type { SidebarWorkspacePlacement } from "@/hooks/use-sidebar-workspaces-list";
import { useSidebarLastChatStore } from "@/stores/sidebar-last-chat-store";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";

/**
 * Whether the row gets the "last open" tag: on a phone, a chip tap only changes the list, so the
 * chat you last had open in the chosen project is marked one tap away. The tag shows only while
 * the strip shows that one project, and not on the row that is already open.
 */
export function useIsProjectLastOpenRow(
  workspace: Pick<SidebarWorkspacePlacement, "serverId" | "workspaceId" | "projectViewKey">,
  selected: boolean,
): boolean {
  const isCompact = useIsCompactFormFactor();
  const showsOnlyThisProject = useSidebarViewStore(
    (state) =>
      state.projectFilters.length === 1 && state.projectFilters[0] === workspace.projectViewKey,
  );
  const isRemembered = useSidebarLastChatStore((state) => {
    const remembered = state.byProject[workspace.projectViewKey];
    return (
      remembered?.serverId === workspace.serverId &&
      remembered.workspaceId === workspace.workspaceId
    );
  });
  return isCompact && showsOnlyThisProject && isRemembered && !selected;
}
