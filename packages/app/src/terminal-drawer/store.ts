import AsyncStorage from "@react-native-async-storage/async-storage";
import { z } from "zod";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import { DESKTOP_DRAWER_DEFAULT_HEIGHT, type PhoneDrawerSnap } from "./model";

/** How one chat's drawer looks on this device. The terminals themselves live on the host. */
export interface ChatDrawerView {
  open: boolean;
  activeTerminalId: string | null;
  phoneSnap: PhoneDrawerSnap;
  maximized: boolean;
}

const CLOSED_VIEW: ChatDrawerView = {
  open: false,
  activeTerminalId: null,
  phoneSnap: "half",
  maximized: false,
};

const ChatDrawerViewSchema = z.strictObject({
  open: z.boolean(),
  activeTerminalId: z.string().nullable(),
  phoneSnap: z.enum(["bar", "half", "full", "chat"]),
  maximized: z.boolean(),
});

const PersistedDrawerStateSchema = z.strictObject({
  chats: z.record(z.string(), ChatDrawerViewSchema),
  desktopHeight: z.number().positive(),
});

type PersistedDrawerState = z.infer<typeof PersistedDrawerStateSchema>;

interface TerminalDrawerStoreState extends PersistedDrawerState {
  /** Bumped to ask a mounted drawer to focus its terminal. Not persisted. */
  focusRequests: Record<string, number>;
  updateChat: (key: string, patch: Partial<ChatDrawerView>) => void;
  requestFocus: (key: string) => void;
  setDesktopHeight: (height: number) => void;
}

export const useTerminalDrawerStore = create<TerminalDrawerStoreState>()(
  persist(
    (set) => ({
      chats: {},
      desktopHeight: DESKTOP_DRAWER_DEFAULT_HEIGHT,
      focusRequests: {},
      updateChat: (key, patch) =>
        set((state) => {
          const next = { ...(state.chats[key] ?? CLOSED_VIEW), ...patch };
          const chats = { ...state.chats };
          // A closed drawer in its default shape needs no entry, so archived chats do not pile up.
          if (!next.open && next.phoneSnap === "half" && !next.maximized) {
            delete chats[key];
          } else {
            chats[key] = next;
          }
          return { chats };
        }),
      requestFocus: (key) =>
        set((state) => ({
          focusRequests: { ...state.focusRequests, [key]: (state.focusRequests[key] ?? 0) + 1 },
        })),
      setDesktopHeight: (desktopHeight) => set({ desktopHeight }),
    }),
    {
      name: "terminal-drawer",
      version: 1,
      storage: createValidatedPersistStorage(AsyncStorage, PersistedDrawerStateSchema),
      partialize: (state): PersistedDrawerState => ({
        chats: state.chats,
        desktopHeight: state.desktopHeight,
      }),
    },
  ),
);

export function useChatDrawerView(key: string): ChatDrawerView {
  return useTerminalDrawerStore((state) => state.chats[key] ?? CLOSED_VIEW);
}
