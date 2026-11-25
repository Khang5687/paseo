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
import { useRecentWorkspacesStore } from "@/stores/recent-workspaces-store";
import { useWaitingWorkspaces } from "@/hooks/use-waiting-workspaces";
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

/** Records every opened workspace as the newest visit, for the Opt+Tab walk. */
function useRecordRecentWorkspace(): void {
  const openWorkspace = useLastWorkspaceSelection();
  const visit = useRecentWorkspacesStore((state) => state.visit);
  useEffect(() => {
    if (openWorkspace) visit(openWorkspace);
  }, [openWorkspace, visit]);
}

const NO_LISTED_WORKSPACES: ReadonlySet<string> = new Set();

/** Publishes what the waiting jump and the recent walk need to the keyboard routing. */
function usePublishJumpTargets(enabled: boolean): void {
  const { allProjects } = useSidebarModel();
  const waitingWorkspaces = useWaitingWorkspaces();
  const setJumpTargets = useKeyboardShortcutsStore((state) => state.setJumpTargets);
  const listedWorkspaceKeys = useMemo(
    () =>
      new Set(
        allProjects.flatMap((project) =>
          project.workspaces.map((workspace) => workspace.workspaceKey),
        ),
      ),
    [allProjects],
  );
  useEffect(() => {
    setJumpTargets(
      enabled
        ? { waitingWorkspaces, listedWorkspaceKeys }
        : { waitingWorkspaces: [], listedWorkspaceKeys: NO_LISTED_WORKSPACES },
    );
  }, [enabled, listedWorkspaceKeys, setJumpTargets, waitingWorkspaces]);
}

export function WorkspaceShortcutTargetsSubscriber({ enabled }: { enabled: boolean }) {
  const { shortcutModel, stripProjects } = useSidebarModel();
  const lastChatByProject = useSidebarLastChatStore((state) => state.byProject);
  const setSidebarShortcutWorkspaceTargets = useKeyboardShortcutsStore(
    (state) => state.setSidebarShortcutWorkspaceTargets,
  );
  const setSidebarShortcutProjects = useKeyboardShortcutsStore(
    (state) => state.setSidebarShortcutProjects,
  );
  useRememberProjectLastChat();
  useRecordRecentWorkspace();
  usePublishJumpTargets(enabled);
  const projects = useMemo((): SidebarShortcutProjectTarget[] => {
    // The rail's order: projects folded into "More" come after the ones that show.
    const stripOrder = [...stripProjects.active, ...stripProjects.quiet];
    const keys = new Set(
      resolveProjectStripShortcutKeys(stripOrder.map((project) => project.viewKey)),
    );
    return stripOrder
      .filter((project) => keys.has(project.viewKey))
      .map((project) => ({
        projectViewKey: project.viewKey,
        lastChat: resolveProjectLastChat(project, lastChatByProject[project.viewKey]),
      }));
  }, [stripProjects, lastChatByProject]);

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
