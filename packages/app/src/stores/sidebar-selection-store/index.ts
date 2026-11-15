import { create } from "zustand";
import {
  addToSidebarSelection,
  INACTIVE_SIDEBAR_SELECTION,
  selectSidebarRange,
  startSidebarSelection,
  toggleSidebarSelection,
  type SidebarSelection,
} from "./state";

export type { SidebarSelection } from "./state";

interface SidebarSelectionStoreState {
  selection: SidebarSelection;
  /** Turns selection on with nothing ticked; leaves an existing selection alone. */
  enter: () => void;
  add: (key: string) => void;
  toggle: (key: string) => void;
  selectRange: (input: Parameters<typeof selectSidebarRange>[1]) => void;
  clear: () => void;
}

export const useSidebarSelectionStore = create<SidebarSelectionStoreState>()((set) => ({
  selection: INACTIVE_SIDEBAR_SELECTION,
  enter: () =>
    set((state) => (state.selection.active ? state : { selection: startSidebarSelection(null) })),
  add: (key) => set((state) => ({ selection: addToSidebarSelection(state.selection, key) })),
  toggle: (key) => set((state) => ({ selection: toggleSidebarSelection(state.selection, key) })),
  selectRange: (input) =>
    set((state) => ({ selection: selectSidebarRange(state.selection, input) })),
  clear: () => set({ selection: INACTIVE_SIDEBAR_SELECTION }),
}));
