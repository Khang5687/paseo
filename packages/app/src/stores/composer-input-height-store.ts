import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

/** Phones and wide windows default differently, so each keeps its own dragged size. */
export type ComposerInputLayout = "compact" | "wide";

const ComposerInputHeightPersistedStateSchema = z.strictObject({
  compact: z.number().positive().nullable(),
  wide: z.number().positive().nullable(),
});

type ComposerInputHeightPersistedState = z.infer<typeof ComposerInputHeightPersistedStateSchema>;

interface ComposerInputHeightState extends ComposerInputHeightPersistedState {
  setMaxInputHeight: (layout: ComposerInputLayout, height: number) => void;
  resetMaxInputHeight: (layout: ComposerInputLayout) => void;
}

/** The composer input's dragged max height on this device; null keeps the layout default. */
export const useComposerInputHeightStore = create<ComposerInputHeightState>()(
  persist(
    (set) => ({
      compact: null,
      wide: null,
      setMaxInputHeight: (layout, height) => set({ [layout]: height }),
      resetMaxInputHeight: (layout) => set({ [layout]: null }),
    }),
    {
      name: "composer-input-height",
      version: 1,
      storage: createValidatedPersistStorage(AsyncStorage, ComposerInputHeightPersistedStateSchema),
      partialize: (state) => ({ compact: state.compact, wide: state.wide }),
    },
  ),
);
