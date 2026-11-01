import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/contexts/toast-context";
import { useImageAttachmentPicker } from "@/hooks/use-image-attachment-picker";
import type { PickedImageAttachmentInput } from "@/hooks/image-attachment-picker";
import {
  importLocalSkin,
  previewSkin,
  selectSkin,
  useSkinPreferences,
  type SkinScheme,
  type SkinSchemeTarget,
} from "@/skins";
import { isSkinSelected, skinNameFromFileName, type SkinSelection } from "./selection";

const PREVIEW_DEBOUNCE_MS = 120;
const UNDO_WINDOW_MS = 8000;

/** Pending key of the "None" card; skin cards use their id. */
export const NONE_CARD_KEY = "none";
/** Pending key of the "Add image…" card. */
export const ADD_CARD_KEY = "add-image";

const SCHEMES: readonly SkinScheme[] = ["light", "dark"];

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

interface ImageSourceUri {
  uri: string;
  release: () => void;
}

function resolvePickedImageUri(picked: PickedImageAttachmentInput): ImageSourceUri {
  switch (picked.source.kind) {
    case "file_uri":
      return { uri: picked.source.uri, release: () => undefined };
    case "data_url":
      return { uri: picked.source.dataUrl, release: () => undefined };
    case "blob": {
      const uri = URL.createObjectURL(picked.source.blob);
      return { uri, release: () => URL.revokeObjectURL(uri) };
    }
  }
}

export interface BackgroundGallery {
  target: SkinSchemeTarget;
  setTarget: (target: SkinSchemeTarget) => void;
  /** Key of the card whose select/import is in flight; null when idle. */
  pendingKey: string | null;
  canUndo: boolean;
  isSelected: (id: string | null) => boolean;
  commit: (id: string | null) => void;
  addImage: () => void;
  undo: () => void;
  schedulePreview: (id: string) => void;
  cancelPreview: () => void;
  endPreview: () => void;
  previewActive: boolean;
}

/**
 * State and actions behind the Background gallery: the "Apply to" target, debounced live
 * preview, committing a selection, importing an image, and undoing the last change.
 */
export function useBackgroundGallery(): BackgroundGallery {
  const { t } = useTranslation();
  const toast = useToast();
  const preferences = useSkinPreferences();
  const { pickImages } = useImageAttachmentPicker();

  const [target, setTarget] = useState<SkinSchemeTarget>("both");
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [undoSelection, setUndoSelection] = useState<SkinSelection | null>(null);

  const selectionRef = useRef(preferences.selection);
  selectionRef.current = preferences.selection;
  const pendingRef = useRef<string | null>(null);
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewActive = preferences.preview !== null;

  const clearPreviewTimer = useCallback(() => {
    if (previewTimerRef.current !== null) {
      clearTimeout(previewTimerRef.current);
      previewTimerRef.current = null;
    }
  }, []);

  const clearUndoTimer = useCallback(() => {
    if (undoTimerRef.current !== null) {
      clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
  }, []);

  const schedulePreview = useCallback(
    (id: string) => {
      clearPreviewTimer();
      if (pendingRef.current !== null) return;
      previewTimerRef.current = setTimeout(() => {
        previewTimerRef.current = null;
        previewSkin(id);
      }, PREVIEW_DEBOUNCE_MS);
    },
    [clearPreviewTimer],
  );

  const cancelPreview = useCallback(() => {
    clearPreviewTimer();
  }, [clearPreviewTimer]);

  const endPreview = useCallback(() => {
    clearPreviewTimer();
    previewSkin(null);
  }, [clearPreviewTimer]);

  useEffect(
    () => () => {
      clearPreviewTimer();
      clearUndoTimer();
      previewSkin(null);
    },
    [clearPreviewTimer, clearUndoTimer],
  );

  const offerUndo = useCallback(
    (previous: SkinSelection) => {
      clearUndoTimer();
      setUndoSelection(previous);
      undoTimerRef.current = setTimeout(() => {
        undoTimerRef.current = null;
        setUndoSelection(null);
      }, UNDO_WINDOW_MS);
    },
    [clearUndoTimer],
  );

  const runExclusive = useCallback(
    async (
      key: string,
      work: () => Promise<void>,
      describeFailure: (message: string) => string,
    ) => {
      if (pendingRef.current !== null) return;
      pendingRef.current = key;
      setPendingKey(key);
      try {
        await work();
      } catch (error) {
        toast.error(describeFailure(errorMessage(error)));
      } finally {
        pendingRef.current = null;
        setPendingKey(null);
      }
    },
    [toast],
  );

  const selectFailure = useCallback(
    (message: string) => t("settings.appearance.background.errors.select", { message }),
    [t],
  );

  const commit = useCallback(
    (id: string | null) => {
      endPreview();
      const previous = selectionRef.current;
      const changes = !isSkinSelected(previous, id, target);
      void runExclusive(
        id ?? NONE_CARD_KEY,
        async () => {
          await selectSkin(id, target);
          previewSkin(null);
          if (changes) offerUndo(previous);
        },
        selectFailure,
      );
    },
    [endPreview, offerUndo, runExclusive, selectFailure, target],
  );

  const addImage = useCallback(() => {
    endPreview();
    const previous = selectionRef.current;
    void runExclusive(
      ADD_CARD_KEY,
      async () => {
        const picked = await pickImages();
        const first = picked?.[0];
        if (!first) return;
        const source = resolvePickedImageUri(first);
        try {
          const skin = await importLocalSkin({
            uri: source.uri,
            name: skinNameFromFileName(
              first.fileName,
              t("settings.appearance.background.gallery.importDefaultName"),
            ),
            mimeType: first.mimeType,
          });
          await selectSkin(skin.id, target);
          previewSkin(null);
          offerUndo(previous);
        } finally {
          source.release();
        }
      },
      (message) => t("settings.appearance.background.errors.import", { message }),
    );
  }, [endPreview, offerUndo, pickImages, runExclusive, t, target]);

  const undo = useCallback(() => {
    if (!undoSelection) return;
    const previous = undoSelection;
    clearUndoTimer();
    setUndoSelection(null);
    void runExclusive(
      NONE_CARD_KEY,
      async () => {
        for (const scheme of SCHEMES) {
          if (selectionRef.current[scheme] !== previous[scheme]) {
            await selectSkin(previous[scheme], scheme);
          }
        }
      },
      selectFailure,
    );
  }, [clearUndoTimer, runExclusive, selectFailure, undoSelection]);

  const isSelected = useCallback(
    (id: string | null) => isSkinSelected(preferences.selection, id, target),
    [preferences.selection, target],
  );

  return {
    target,
    setTarget,
    pendingKey,
    canUndo: undoSelection !== null,
    isSelected,
    commit,
    addImage,
    undo,
    schedulePreview,
    cancelPreview,
    endPreview,
    previewActive,
  };
}
