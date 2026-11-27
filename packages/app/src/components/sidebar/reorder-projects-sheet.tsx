import { GripVertical } from "lucide-react-native";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { AdaptiveModalSheet, FULL_SHEET_SNAP_POINTS } from "@/components/adaptive-modal-sheet";
import { DraggableList, DraggableListHandle } from "@/components/draggable-list";
import type { DraggableRenderItemInfo } from "@/components/draggable-list.types";
import { ProjectIconView } from "@/components/project-icon-view";
import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";
import type { Theme } from "@/styles/theme";
import { projectIconPlaceholderLabelFromDisplayName } from "@/utils/project-display-name";
import { saveProjectStripOrder, useReorderProjectsSheetStore } from "./project-order";

const ThemedGripVertical = withUnistyles(GripVertical);
const gripIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ICON_SIZE = 28;

/**
 * The phone's Reorder projects sheet: every project in one list, held and dragged into place. The
 * desktop drags on the open rail instead, so "Reorder projects…" opens this only on compact.
 *
 * A phone sheet renders outside the app's providers, so the owner passes the projects and icons in.
 */
export function ReorderProjectsSheet({
  projects,
  iconByViewKey,
}: {
  projects: SidebarProjectEntry[];
  iconByViewKey: ReadonlyMap<string, string | null>;
}) {
  const { t } = useTranslation();
  const visible = useReorderProjectsSheetStore((state) => state.open);
  const setOpen = useReorderProjectsSheetStore((state) => state.setOpen);
  const handleClose = useCallback(() => setOpen(false), [setOpen]);
  const header = useMemo(() => ({ title: t("sidebar.projectStrip.reorderTitle") }), [t]);

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={handleClose}
      snapPoints={FULL_SHEET_SNAP_POINTS}
      testID="reorder-projects-sheet"
    >
      {visible ? <ReorderProjectsList projects={projects} iconByViewKey={iconByViewKey} /> : null}
    </AdaptiveModalSheet>
  );
}

function ReorderProjectsList({
  projects,
  iconByViewKey,
}: {
  projects: SidebarProjectEntry[];
  iconByViewKey: ReadonlyMap<string, string | null>;
}) {
  const { t } = useTranslation();

  const handleDragEnd = useCallback((reordered: SidebarProjectEntry[]) => {
    saveProjectStripOrder(reordered.map((project) => project.viewKey));
  }, []);
  const renderItem = useCallback(
    ({ item }: DraggableRenderItemInfo<SidebarProjectEntry>) => (
      <ReorderProjectRow project={item} iconDataUri={iconByViewKey.get(item.viewKey) ?? null} />
    ),
    [iconByViewKey],
  );

  return (
    <View style={styles.body}>
      <Text style={styles.hint}>{t("sidebar.projectStrip.reorderHint")}</Text>
      <DraggableList
        testID="reorder-projects-list"
        data={projects}
        keyExtractor={projectViewKeyExtractor}
        renderItem={renderItem}
        onDragEnd={handleDragEnd}
        extraData={iconByViewKey}
        scrollEnabled={false}
        useDragHandle
      />
    </View>
  );
}

function projectViewKeyExtractor(project: SidebarProjectEntry): string {
  return project.viewKey;
}

// The whole row is the handle: a finger held anywhere on it picks the project up, and a quick
// swipe still scrolls the sheet (docs/drag-reorder.md).
function ReorderProjectRow({
  project,
  iconDataUri,
}: {
  project: SidebarProjectEntry;
  iconDataUri: string | null;
}) {
  return (
    <DraggableListHandle
      accessibilityLabel={project.projectName}
      style={styles.row}
      testID={`reorder-projects-row-${project.viewKey}`}
    >
      <ProjectIconView
        iconDataUri={iconDataUri}
        initial={projectIconPlaceholderLabelFromDisplayName(project.projectName)
          .charAt(0)
          .toUpperCase()}
        projectViewKey={project.viewKey}
        size={ICON_SIZE}
        textStyle={styles.iconText}
      />
      <Text style={styles.name} numberOfLines={1}>
        {project.projectName}
      </Text>
      <ThemedGripVertical size={16} uniProps={gripIconMapping} />
    </DraggableListHandle>
  );
}

// The sheet pads its body to the header's rail, so the hint and rows add no side padding.
const styles = StyleSheet.create((theme) => ({
  body: {
    paddingBottom: theme.spacing[4],
    gap: theme.spacing[2],
  },
  hint: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    paddingTop: theme.spacing[2],
  },
  row: {
    width: "100%",
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    backgroundColor: theme.colors.surface0,
  },
  iconText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  name: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
}));
