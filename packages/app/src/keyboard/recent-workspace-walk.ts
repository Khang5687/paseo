import { isWeb } from "@/constants/platform";
import type { JumpTarget } from "@/components/sidebar/jump-targets";
import type { ShortcutBadgeModifiers } from "@/keyboard/keyboard-shortcuts";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useRecentWorkspacesStore } from "@/stores/recent-workspaces-store";

/** Opens the highlighted workspace and closes the walk. */
export function finishRecentWorkspaceWalk(): void {
  const target = useRecentWorkspacesStore.getState().finish();
  if (target) navigateToWorkspace(target);
}

/**
 * One Opt+Tab press. On web the walk stays open, with the list on screen, until the modifier
 * is released. A native hardware keyboard does not report that release reliably, so there each
 * press opens the previous workspace at once, like a quick tap of the app switcher.
 */
export function stepRecentWorkspaceWalk(delta: 1 | -1, current: JumpTarget | null): boolean {
  const { listedWorkspaceKeys } = useKeyboardShortcutsStore.getState();
  const target = useRecentWorkspacesStore.getState().step({
    delta,
    current,
    isListed: (entry) => listedWorkspaceKeys.has(`${entry.serverId}:${entry.workspaceId}`),
  });
  if (!target) return false;
  if (!isWeb) finishRecentWorkspaceWalk();
  return true;
}

/** Called on every key release: letting go of the last held modifier ends an open walk. */
export function releaseRecentWorkspaceWalk(held: ShortcutBadgeModifiers): void {
  if (!useRecentWorkspacesStore.getState().walk) return;
  if (held.alt || held.ctrl || held.meta) return;
  finishRecentWorkspaceWalk();
}

export function cancelRecentWorkspaceWalk(): void {
  useRecentWorkspacesStore.getState().cancel();
}
