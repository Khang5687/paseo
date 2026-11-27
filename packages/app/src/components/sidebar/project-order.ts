import { useCallback, useEffect } from "react";
import { create } from "zustand";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import { useSidebarRailOpenStore } from "@/stores/sidebar-rail-open-store";
import { hasVisibleOrderChanged, mergeWithRemainder } from "@/utils/sidebar-reorder";

/**
 * Saves a new project order. The strip and the sidebar's project list share one order, so a
 * drag on the strip moves the project's block in the list too, and projects another host filter
 * hides keep their place after the visible ones.
 */
export function saveProjectStripOrder(reorderedKeys: string[]): void {
  const { getProjectOrder, setProjectOrder } = useSidebarOrderStore.getState();
  const currentOrder = getProjectOrder();
  if (!hasVisibleOrderChanged({ currentOrder, reorderedVisibleKeys: reorderedKeys })) return;
  setProjectOrder(mergeWithRemainder({ currentOrder, reorderedVisibleKeys: reorderedKeys }));
}

interface ProjectOrderKeysState {
  /** Every project's key in the shared order, as `SidebarModelProvider` last saw it. */
  keys: readonly string[];
}

/**
 * The project order outside React context. Menus on a phone render in a bottom sheet that sits
 * outside `SidebarModelProvider`, so the ⋯ menu's moves read the order here.
 */
export const useProjectOrderKeysStore = create<ProjectOrderKeysState>()(() => ({ keys: [] }));

/** Called by `SidebarModelProvider` with its projects in order. */
export function usePublishProjectOrderKeys(projects: readonly { viewKey: string }[]): void {
  useEffect(() => {
    const keys = projects.map((project) => project.viewKey);
    const current = useProjectOrderKeysStore.getState().keys;
    if (keys.length === current.length && keys.every((key, index) => key === current[index])) {
      return;
    }
    useProjectOrderKeysStore.setState({ keys });
  }, [projects]);
}

interface ReorderProjectsSheetState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

/** Whether the phone's Reorder projects sheet shows. Not stored: it opens from a menu each time. */
export const useReorderProjectsSheetStore = create<ReorderProjectsSheetState>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

/**
 * "Reorder projects…": the desktop opens the rail wide to drag there; a phone, which has no rail,
 * opens the Reorder projects sheet.
 */
export function useOpenReorderProjects(): () => void {
  const isCompact = useIsCompactFormFactor();
  const setRailOpen = useSidebarRailOpenStore((state) => state.setOpen);
  const setSheetOpen = useReorderProjectsSheetStore((state) => state.setOpen);
  return useCallback(() => {
    if (isCompact) setSheetOpen(true);
    else setRailOpen(true);
  }, [isCompact, setRailOpen, setSheetOpen]);
}
