import { create } from "zustand";

/**
 * Whether "More" is open, shared by the rail, the chip row and the project list so one tap
 * opens all of them. Not persisted: quiet projects start folded each launch.
 */
interface SidebarQuietFoldState {
  open: boolean;
  toggle: () => void;
}

export const useSidebarQuietFoldStore = create<SidebarQuietFoldState>((set) => ({
  open: false,
  toggle: () => set((state) => ({ open: !state.open })),
}));
