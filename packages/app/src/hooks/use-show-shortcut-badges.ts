import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";

/** True while the workspace-row jump modifiers are held: the sidebar rows show their numbers. */
export function useShowShortcutBadges(): boolean {
  return useKeyboardShortcutsStore((state) => state.shortcutBadgeTarget === "workspace");
}

/** True while the project jump modifier is held: the project strip shows its numbers. */
export function useShowProjectShortcutBadges(): boolean {
  return useKeyboardShortcutsStore((state) => state.shortcutBadgeTarget === "project");
}
