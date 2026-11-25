import { useEffect, useMemo } from "react";
import {
  findProjectForWorkspace,
  resolveProjectLastChat,
} from "@/components/sidebar/project-last-chat";
import { resolveProjectStripShortcutKeys } from "@/components/sidebar/project-strip-model";
import { useSidebarModel } from "@/components/sidebar/sidebar-model";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { useLastWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useSidebarLastChatStore } from "@/stores/sidebar-last-chat-store";
import type { SidebarShortcutProjectTarget } from "@/utils/sidebar-shortcuts";

/**
 * Remembers the open workspace as its project's last chat. The project list is read on every
 * change because a workspace opened before its host's directory loaded has no project yet.
 */
function useRememberProjectLastChat(): void {
  const { allProjects } = useSidebarModel();
  const openWorkspace = useLastWorkspaceSelection();
  const remember = useSidebarLastChatStore((state) => state.remember);

  useEffect(() => {
    if (!openWorkspace) return;
    const projectViewKey = findProjectForWorkspace(allProjects, openWorkspace);
    if (projectViewKey) remember(projectViewKey, openWorkspace);
  }, [allProjects, openWorkspace, remember]);
}

export function WorkspaceShortcutTargetsSubscriber({ enabled }: { enabled: boolean }) {
  const { shortcutModel, allProjects } = useSidebarModel();
  const lastChatByProject = useSidebarLastChatStore((state) => state.byProject);
  const setSidebarShortcutWorkspaceTargets = useKeyboardShortcutsStore(
    (state) => state.setSidebarShortcutWorkspaceTargets,
  );
  const setSidebarShortcutProjects = useKeyboardShortcutsStore(
    (state) => state.setSidebarShortcutProjects,
  );
  useRememberProjectLastChat();
  const projects = useMemo((): SidebarShortcutProjectTarget[] => {
    const keys = new Set(
      resolveProjectStripShortcutKeys(allProjects.map((project) => project.viewKey)),
    );
    return allProjects
      .filter((project) => keys.has(project.viewKey))
      .map((project) => ({
        projectViewKey: project.viewKey,
        lastChat: resolveProjectLastChat(project, lastChatByProject[project.viewKey]),
      }));
  }, [allProjects, lastChatByProject]);

  useEffect(() => {
    if (!enabled) {
      setSidebarShortcutWorkspaceTargets([]);
      setSidebarShortcutProjects([]);
      return;
    }

    setSidebarShortcutWorkspaceTargets(shortcutModel.shortcutTargets);
    setSidebarShortcutProjects(projects);
  }, [
    enabled,
    projects,
    setSidebarShortcutProjects,
    setSidebarShortcutWorkspaceTargets,
    shortcutModel.shortcutTargets,
  ]);

  useEffect(() => {
    return () => {
      setSidebarShortcutWorkspaceTargets([]);
      setSidebarShortcutProjects([]);
    };
  }, [setSidebarShortcutProjects, setSidebarShortcutWorkspaceTargets]);

  return null;
}
