import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

/**
 * Whether the desktop project rail is open wide, with each project's name beside its icon.
 * Stored per device, so the rail comes back the way you left it.
 */
interface SidebarRailOpenState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

const SidebarRailOpenPersistedStateSchema = z.strictObject({
  open: z.boolean(),
});

export const useSidebarRailOpenStore = create<SidebarRailOpenState>()(
  persist(
    (set) => ({
      open: false,
      setOpen: (open) => set({ open }),
    }),
    {
      name: "sidebar-project-rail-open",
      storage: createValidatedPersistStorage(AsyncStorage, SidebarRailOpenPersistedStateSchema),
      partialize: (state) => ({ open: state.open }),
      version: 1,
    },
  ),
);
