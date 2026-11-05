import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import {
  clampBlurRadius,
  clampUnit,
  DEFAULT_SKIN_PREFERENCES,
  skinPreferencesSchema,
} from "./preferences-schema";
import type { SkinPreferences, SkinSchemeTarget } from "./types";

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

/**
 * Values shown while a control is dragged. Kept out of the persisted store, which writes storage
 * on every change; the setters below write once, when the drag ends.
 */
interface SkinAdjustmentState {
  visibility: number | null;
  blur: number | null;
}

const useSkinAdjustmentStore = create<SkinAdjustmentState>()(() => ({
  visibility: null,
  blur: null,
}));

/** Visibility the art is drawn with: the dragged value, else the saved one. */
export function useSkinVisibility(): number {
  const adjusting = useSkinAdjustmentStore((state) => state.visibility);
  const saved = useSkinPreferencesStore((state) => state.visibility);
  return adjusting ?? saved;
}

/** Blur radius the art is drawn with: the dragged value, else the saved one. */
export function useSkinBlur(): number {
  const adjusting = useSkinAdjustmentStore((state) => state.blur);
  const saved = useSkinPreferencesStore((state) => state.blur);
  return adjusting ?? saved;
}

export function previewSkinVisibility(visibility: number): void {
  useSkinAdjustmentStore.setState({ visibility: clampUnit(visibility) });
}

export function previewSkinBlur(blur: number): void {
  useSkinAdjustmentStore.setState({ blur: clampBlurRadius(blur) });
}

export function setSkinVisibility(visibility: number): void {
  const next = clampUnit(visibility);
  if (useSkinPreferencesStore.getState().visibility !== next) {
    useSkinPreferencesStore.setState({ visibility: next });
  }
  useSkinAdjustmentStore.setState({ visibility: null });
}

export function setSkinBlur(blur: number): void {
  const next = clampBlurRadius(blur);
  if (useSkinPreferencesStore.getState().blur !== next) {
    useSkinPreferencesStore.setState({ blur: next });
  }
  useSkinAdjustmentStore.setState({ blur: null });
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
