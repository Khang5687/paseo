import type { ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { DismissToast, ToastApi } from "@/components/toast-host";
import { removeOfflineFiles, type OfflineFileKey } from "./store";

const UNDO_WINDOW_MS = 6000;

interface SavedDeleteInput {
  toast: ToastApi;
  files: readonly OfflineFileKey[];
  release: () => void;
}

/**
 * One Delete in the Saved screen's select mode. The caller hides the files at once; they leave the
 * device when the Undo toast leaves, whichever way it leaves (timeout, swipe, another toast), unless
 * Undo was pressed. `release` runs once either way so the caller can stop hiding them.
 */
export function deleteSavedFilesWithUndo(input: SavedDeleteInput): void {
  // A class, not closures, so the toast gets stable handlers (react-perf lint).
  void new SavedDeleteUndo(input);
}

class SavedDeleteUndo {
  private undone = false;
  private readonly dismiss: DismissToast;

  constructor(private readonly input: SavedDeleteInput) {
    this.dismiss = input.toast.show(
      <DeletedToast count={input.files.length} onUndo={this.undo} />,
      {
        layout: "action",
        durationMs: UNDO_WINDOW_MS,
        testID: "saved-deleted-toast",
        onDismiss: this.close,
      },
    );
  }

  private readonly undo = (): void => {
    this.undone = true;
    this.input.release();
    this.dismiss();
  };

  private readonly close = (): void => {
    if (this.undone) return;
    void removeOfflineFiles(this.input.files).finally(this.input.release);
  };
}

function DeletedToast({ count, onUndo }: { count: number; onUndo: () => void }): ReactElement {
  const { t } = useTranslation();
  return (
    <View style={styles.row}>
      <Text style={styles.text}>{t("offlineFiles.library.select.deleted", { count })}</Text>
      <Button size="sm" onPress={onUndo} testID="saved-deleted-undo">
        {t("offlineFiles.library.select.undo")}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  text: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
}));
