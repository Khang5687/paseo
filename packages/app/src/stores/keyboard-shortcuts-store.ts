import { create } from "zustand";
import type { CommandCenterTab } from "@/command-center/tabs";
import type { ShortcutBadgeTarget } from "@/keyboard/keyboard-shortcuts";
import type {
  SidebarShortcutProjectTarget,
  SidebarShortcutWorkspaceTarget,
} from "@/utils/sidebar-shortcuts";

const SHORTCUT_BADGE_DELAY_MS = 150;

interface KeyboardShortcutsState {
  commandCenterOpen: boolean;
  /** The tab the open command center shows. Every opening starts on the tab it asks for. */
  commandCenterTab: CommandCenterTab;
  shortcutsDialogOpen: boolean;
  capturingShortcut: boolean;
  /** The number-badge group whose modifiers are held right now. */
  heldBadgeTarget: ShortcutBadgeTarget | null;
  /** The number-badge group on screen: `heldBadgeTarget`, once it has been held for a moment. */
  shortcutBadgeTarget: ShortcutBadgeTarget | null;
  /** Sidebar-visible workspace targets (up to 9), in top-to-bottom visual order. */
  sidebarShortcutWorkspaceTargets: SidebarShortcutWorkspaceTarget[];
  /** Project strip entries by strip position: index 0 answers the first digit. */
  sidebarShortcutProjects: SidebarShortcutProjectTarget[];

  setCommandCenterOpen: (open: boolean, tab?: CommandCenterTab) => void;
  setCommandCenterTab: (tab: CommandCenterTab) => void;
  setShortcutsDialogOpen: (open: boolean) => void;
  setCapturingShortcut: (capturing: boolean) => void;
  setHeldBadgeTarget: (target: ShortcutBadgeTarget | null) => void;
  setSidebarShortcutWorkspaceTargets: (targets: SidebarShortcutWorkspaceTarget[]) => void;
  setSidebarShortcutProjects: (projects: SidebarShortcutProjectTarget[]) => void;
  resetModifiers: () => void;
}

let badgeTimer: ReturnType<typeof setTimeout> | null = null;

function updateBadgeTimer(
  set: (partial: Partial<KeyboardShortcutsState>) => void,
  get: () => KeyboardShortcutsState,
) {
  const { heldBadgeTarget } = get();

  if (badgeTimer) {
    clearTimeout(badgeTimer);
    badgeTimer = null;
  }

  if (heldBadgeTarget) {
    badgeTimer = setTimeout(() => {
      set({ shortcutBadgeTarget: heldBadgeTarget });
    }, SHORTCUT_BADGE_DELAY_MS);
  } else {
    set({ shortcutBadgeTarget: null });
  }
}

export const useKeyboardShortcutsStore = create<KeyboardShortcutsState>((set, get) => ({
  commandCenterOpen: false,
  commandCenterTab: "all",
  shortcutsDialogOpen: false,
  capturingShortcut: false,
  heldBadgeTarget: null,
  shortcutBadgeTarget: null,
  sidebarShortcutWorkspaceTargets: [],
  sidebarShortcutProjects: [],

  setCommandCenterOpen: (open, tab = "all") =>
    set({ commandCenterOpen: open, commandCenterTab: open ? tab : "all" }),
  setCommandCenterTab: (tab) => set({ commandCenterTab: tab }),
  setShortcutsDialogOpen: (open) => set({ shortcutsDialogOpen: open }),
  setCapturingShortcut: (capturing) => set({ capturingShortcut: capturing }),
  setHeldBadgeTarget: (target) => {
    if (get().heldBadgeTarget === target) return;
    set({ heldBadgeTarget: target });
    updateBadgeTimer(set, get);
  },
  setSidebarShortcutWorkspaceTargets: (targets) =>
    set({ sidebarShortcutWorkspaceTargets: targets }),
  setSidebarShortcutProjects: (projects) => set({ sidebarShortcutProjects: projects }),
  resetModifiers: () => {
    set({ heldBadgeTarget: null });
    updateBadgeTimer(set, get);
  },
}));
