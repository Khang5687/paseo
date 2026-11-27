import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import type { ProjectLastChat } from "@/components/sidebar/project-last-chat";

/**
 * The workspace you last had open in each project, keyed by project view key. The project strip
 * reopens it when you jump to that project. Stored per device.
 */
interface SidebarLastChatState {
  byProject: Record<string, ProjectLastChat>;
  remember: (projectViewKey: string, chat: ProjectLastChat) => void;
}

const ProjectLastChatSchema = z.strictObject({
  serverId: z.string(),
  workspaceId: z.string(),
});

const SidebarLastChatPersistedStateSchema = z.strictObject({
  byProject: z.record(z.string(), ProjectLastChatSchema),
});

export const useSidebarLastChatStore = create<SidebarLastChatState>()(
  persist(
    (set, get) => ({
      byProject: {},
      remember: (projectViewKey, chat) => {
        const current = get().byProject[projectViewKey];
        if (current?.serverId === chat.serverId && current.workspaceId === chat.workspaceId) {
          return;
        }
        set((state) => ({
          byProject: {
            ...state.byProject,
            [projectViewKey]: { serverId: chat.serverId, workspaceId: chat.workspaceId },
          },
        }));
      },
    }),
    {
      name: "sidebar-project-last-chat",
      storage: createValidatedPersistStorage(AsyncStorage, SidebarLastChatPersistedStateSchema),
      partialize: (state) => ({ byProject: state.byProject }),
      version: 1,
    },
  ),
);
