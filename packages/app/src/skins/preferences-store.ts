import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import { clampUnit, DEFAULT_SKIN_PREFERENCES, skinPreferencesSchema } from "./preferences-schema";
import type { SkinBlur, SkinPreferences, SkinSchemeTarget } from "./types";

export interface SkinPreferencesStoreState extends SkinPreferences {
  /** Transient skin shown while browsing the gallery. Never persisted. */
  preview: string | null;
}

export const useSkinPreferencesStore = create<SkinPreferencesStoreState>()(
  persist(
    (): SkinPreferencesStoreState => ({
      ...DEFAULT_SKIN_PREFERENCES,
      selection: { ...DEFAULT_SKIN_PREFERENCES.selection },
      preview: null,
    }),
    {
      name: "paseo-skin-preferences",
      storage: createValidatedPersistStorage(AsyncStorage, skinPreferencesSchema),
      partialize: (state): SkinPreferences => ({
        selection: state.selection,
        visibility: state.visibility,
        blur: state.blur,
        showBehindSidebar: state.showBehindSidebar,
        showBehindContent: state.showBehindContent,
      }),
      version: 1,
    },
  ),
);

export function setSkinSelection(id: string | null, target: SkinSchemeTarget): void {
  useSkinPreferencesStore.setState((state) => ({
    selection: {
      light: target === "dark" ? state.selection.light : id,
      dark: target === "light" ? state.selection.dark : id,
    },
  }));
}

export function setSkinPreview(id: string | null): void {
  useSkinPreferencesStore.setState({ preview: id });
}

export function setSkinVisibility(visibility: number): void {
  useSkinPreferencesStore.setState({ visibility: clampUnit(visibility) });
}

export function setSkinBlur(blur: SkinBlur): void {
  useSkinPreferencesStore.setState({ blur });
}

export function setSkinShowBehindSidebar(show: boolean): void {
  useSkinPreferencesStore.setState({ showBehindSidebar: show });
}

export function setSkinShowBehindContent(show: boolean): void {
  useSkinPreferencesStore.setState({ showBehindContent: show });
}

export function getSkinPreferences(): SkinPreferences {
  const { selection, visibility, blur, showBehindSidebar, showBehindContent } =
    useSkinPreferencesStore.getState();
  return { selection, visibility, blur, showBehindSidebar, showBehindContent };
}
