import { useEffect, useMemo } from "react";
import { resolveProjectStripShortcutKeys } from "@/components/sidebar/project-strip-model";
import { useSidebarModel } from "@/components/sidebar/sidebar-model";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";

export function WorkspaceShortcutTargetsSubscriber({ enabled }: { enabled: boolean }) {
  const { shortcutModel, allProjects } = useSidebarModel();
  const setSidebarShortcutWorkspaceTargets = useKeyboardShortcutsStore(
    (state) => state.setSidebarShortcutWorkspaceTargets,
  );
  const setSidebarShortcutProjectKeys = useKeyboardShortcutsStore(
    (state) => state.setSidebarShortcutProjectKeys,
  );
  const projectKeys = useMemo(
    () => resolveProjectStripShortcutKeys(allProjects.map((project) => project.viewKey)),
    [allProjects],
  );

  useEffect(() => {
    if (!enabled) {
      setSidebarShortcutWorkspaceTargets([]);
      setSidebarShortcutProjectKeys([]);
      return;
    }

    setSidebarShortcutWorkspaceTargets(shortcutModel.shortcutTargets);
    setSidebarShortcutProjectKeys(projectKeys);
  }, [
    enabled,
    projectKeys,
    setSidebarShortcutProjectKeys,
    setSidebarShortcutWorkspaceTargets,
    shortcutModel.shortcutTargets,
  ]);

  useEffect(() => {
    return () => {
      setSidebarShortcutWorkspaceTargets([]);
      setSidebarShortcutProjectKeys([]);
    };
  }, [setSidebarShortcutProjectKeys, setSidebarShortcutWorkspaceTargets]);

  return null;
}
