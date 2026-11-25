import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import {
  buildRecentWalk,
  type JumpTarget,
  pushRecentWorkspace,
  stepWalkIndex,
} from "@/components/sidebar/jump-targets";

export interface RecentWorkspaceWalk {
  entries: JumpTarget[];
  index: number;
}

/**
 * Workspaces in the order you visited them, newest first, stored per device, plus the walk that
 * Opt+Tab (Ctrl+Tab on Windows and Linux) is stepping through. Visits are not recorded while a
 * walk is open, so stepping past a workspace does not reorder the list under you.
 */
interface RecentWorkspacesState {
  recent: readonly JumpTarget[];
  walk: RecentWorkspaceWalk | null;
  visit: (target: JumpTarget) => void;
  /** Starts a walk when none is open, then moves one step. Returns the highlighted workspace. */
  step: (input: {
    delta: 1 | -1;
    current: JumpTarget | null;
    isListed: (target: JumpTarget) => boolean;
  }) => JumpTarget | null;
  /** Closes the walk and records the highlighted workspace as the newest visit. */
  finish: () => JumpTarget | null;
  cancel: () => void;
}

const JumpTargetSchema = z.strictObject({ serverId: z.string(), workspaceId: z.string() });
const RecentWorkspacesPersistedStateSchema = z.strictObject({
  recent: z.array(JumpTargetSchema),
});

export const useRecentWorkspacesStore = create<RecentWorkspacesState>()(
  persist(
    (set, get) => ({
      recent: [],
      walk: null,
      visit: (target) => {
        const { recent, walk } = get();
        if (walk) return;
        const next = pushRecentWorkspace(recent, target);
        if (next !== recent) set({ recent: next });
      },
      step: ({ delta, current, isListed }) => {
        const open = get().walk;
        const entries =
          open?.entries ?? buildRecentWalk({ recent: get().recent, current, isListed });
        if (entries.length < 2) return null;
        const index = stepWalkIndex(open?.index ?? 0, delta, entries.length);
        set({ walk: { entries, index } });
        return entries[index] ?? null;
      },
      finish: () => {
        const walk = get().walk;
        if (!walk) return null;
        const target = walk.entries[walk.index] ?? null;
        set({ walk: null });
        if (target) get().visit(target);
        return target;
      },
      cancel: () => {
        if (get().walk) set({ walk: null });
      },
    }),
    {
      name: "recent-workspaces",
      storage: createValidatedPersistStorage(AsyncStorage, RecentWorkspacesPersistedStateSchema),
      partialize: (state) => ({ recent: [...state.recent] }),
      version: 1,
    },
  ),
);
