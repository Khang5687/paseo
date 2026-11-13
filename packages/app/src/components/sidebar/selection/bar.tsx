import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useToast } from "@/contexts/toast-context";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import type { ActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useSidebarSelectionStore } from "@/stores/sidebar-selection-store";
import { confirmDialog } from "@/utils/confirm-dialog";
import { archiveSidebarWorkspaces, buildSidebarArchiveMessage } from "./archive";

/** "N selected · Archive · Cancel" under the rows while sidebar selection is on. */
export function SidebarSelectionBar({
  workspaceEntriesByKey,
  activeWorkspaceSelection,
}: {
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  activeWorkspaceSelection: ActiveWorkspaceSelection | null;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const selection = useSidebarSelectionStore((state) => state.selection);
  const clear = useSidebarSelectionStore((state) => state.clear);

  // A ticked row can disappear under the selection (archived elsewhere, filtered out); only the
  // rows that still exist are counted and archived.
  const selectedWorkspaces = useMemo(() => {
    if (!selection.active) return [];
    return [...selection.keys].flatMap((key) => {
      const entry = workspaceEntriesByKey.get(key);
      return entry ? [entry] : [];
    });
  }, [selection, workspaceEntriesByKey]);

  const handleArchive = useCallback(async () => {
    const count = selectedWorkspaces.length;
    if (count === 0) return;
    const confirmed = await confirmDialog({
      title: t("sidebar.selection.archiveTitle", { count }),
      message: buildSidebarArchiveMessage(selectedWorkspaces),
      confirmLabel: t("sidebar.workspace.actions.archive"),
      cancelLabel: t("sidebar.selection.cancel"),
      destructive: true,
    });
    if (!confirmed) return;

    clear();
    const failures = await archiveSidebarWorkspaces({
      workspaces: selectedWorkspaces,
      activeWorkspaceSelection,
    });
    if (failures.length > 0) {
      toast.error(t("sidebar.selection.archiveFailed", { count: failures.length }));
    }
  }, [activeWorkspaceSelection, clear, selectedWorkspaces, t, toast]);

  const handleArchivePress = useCallback(() => {
    void handleArchive();
  }, [handleArchive]);

  if (!selection.active) return null;

  return (
    <View style={styles.bar} testID="sidebar-selection-bar">
      <Text style={styles.count} numberOfLines={1} testID="sidebar-selection-count">
        {t("sidebar.selection.count", { count: selectedWorkspaces.length })}
      </Text>
      <Button
        variant="secondary"
        size="sm"
        disabled={selectedWorkspaces.length === 0}
        onPress={handleArchivePress}
        testID="sidebar-selection-archive"
      >
        {t("sidebar.workspace.actions.archive")}
      </Button>
      <Button variant="ghost" size="sm" onPress={clear} testID="sidebar-selection-cancel">
        {t("sidebar.selection.cancel")}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  count: {
    flex: 1,
    paddingLeft: theme.spacing[1],
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));
