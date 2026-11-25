import { LayoutGrid } from "lucide-react-native";
import { memo, type ReactNode, type RefObject, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";
import { type GestureType, ScrollView as GHScrollView } from "react-native-gesture-handler";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { DraggableList, DraggableListHandle } from "@/components/draggable-list";
import type { DraggableRenderItemInfo } from "@/components/draggable-list.types";
import { ProjectIconView } from "@/components/project-icon-view";
import { useSidebarModel } from "@/components/sidebar/sidebar-model";
import { SidebarWorkspaceShortcutBadge } from "@/components/sidebar/sidebar-workspace-row-content";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { PressHighlight } from "@/components/ui/press-highlight";
import { Shortcut } from "@/components/ui/shortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isNative as platformIsNative } from "@/constants/platform";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { useShowProjectShortcutBadges } from "@/hooks/use-show-shortcut-badges";
import {
  type SidebarProjectEntry,
  useSidebarProjectNeedsInputCount,
} from "@/hooks/use-sidebar-workspaces-list";
import { useProjectIcons } from "@/projects/icons";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import type { Theme } from "@/styles/theme";
import type { ShortcutKey } from "@/utils/format-shortcut";
import { projectIconPlaceholderLabelFromDisplayName } from "@/utils/project-display-name";
import { getStatusDotColor } from "@/utils/status-dot-color";
import { resolveSidebarProjectIconTargets } from "@/utils/sidebar-project-row-model";
import { hasVisibleOrderChanged, mergeWithRemainder } from "@/utils/sidebar-reorder";
import {
  listProjectStripMoves,
  moveProjectStripEntry,
  type ProjectStripMove,
  projectStripShortcutNumber,
  shouldShowProjectStrip,
} from "./project-strip-model";

const RAIL_ICON_SIZE = 28;
const CHIP_ICON_SIZE = 18;
const PROJECT_JUMP_HELP_ID = "sidebar-project-jump-index";

const ThemedLayoutGrid = withUnistyles(LayoutGrid);
const allIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
/** Hover state for the docs/hover.md pattern: the outer View listens, the inner press is separate. */
function useHoverHandlers() {
  const [hovered, setHovered] = useState(false);
  const onPointerEnter = useCallback(() => setHovered(true), []);
  const onPointerLeave = useCallback(() => setHovered(false), []);
  return { hovered, onPointerEnter, onPointerLeave };
}

/**
 * Saves a new strip order. The strip and the sidebar's project list share one order, so a
 * drag here moves the project's block in the list too, and projects another host filter
 * hides keep their place after the visible ones.
 */
function saveProjectStripOrder(reorderedKeys: string[]): void {
  const { getProjectOrder, setProjectOrder } = useSidebarOrderStore.getState();
  const currentOrder = getProjectOrder();
  if (!hasVisibleOrderChanged({ currentOrder, reorderedVisibleKeys: reorderedKeys })) return;
  setProjectOrder(mergeWithRemainder({ currentOrder, reorderedVisibleKeys: reorderedKeys }));
}

interface ProjectStripModel {
  projects: SidebarProjectEntry[];
  projectKeys: string[];
  iconByViewKey: ReadonlyMap<string, string | null>;
  allSelected: boolean;
  selectedKeys: ReadonlySet<string>;
}

function useProjectStripModel(): ProjectStripModel | null {
  const { allProjects, resolvedProjectFilters } = useSidebarModel();
  const iconTargets = useMemo(() => resolveSidebarProjectIconTargets(allProjects), [allProjects]);
  const iconByViewKey = useProjectIcons({ projects: iconTargets });
  const projectKeys = useMemo(() => allProjects.map((project) => project.viewKey), [allProjects]);
  const selectedKeys = useMemo(() => new Set(resolvedProjectFilters), [resolvedProjectFilters]);
  if (!shouldShowProjectStrip(allProjects.length)) return null;
  return {
    projects: allProjects,
    projectKeys,
    iconByViewKey,
    allSelected: resolvedProjectFilters.length === 0,
    selectedKeys,
  };
}

/** The keys that jump to the project at `index`: the jump chord with its digit filled in. */
function useProjectJumpChord(index: number): ShortcutKey[][] | null {
  const chord = useShortcutKeys(PROJECT_JUMP_HELP_ID);
  const number = projectStripShortcutNumber(index);
  return useMemo(() => {
    if (!chord || number === null) return null;
    return chord.map((step) => step.map((key) => (key === "1-9" ? String(number) : key)));
  }, [chord, number]);
}

function projectInitial(displayName: string): string {
  return projectIconPlaceholderLabelFromDisplayName(displayName).charAt(0).toUpperCase();
}

// ---------------------------------------------------------------------------
// Desktop: a vertical rail of project icons left of the sidebar
// ---------------------------------------------------------------------------

/** The desktop sidebar body: the rail on the left, the sidebar's own column beside it. */
export function SidebarProjectRailLayout({ children }: { children: ReactNode }) {
  return (
    <View style={styles.railLayout}>
      <SidebarProjectRail />
      <View style={styles.railLayoutMain}>{children}</View>
    </View>
  );
}

function SidebarProjectRail() {
  const { t } = useTranslation();
  const model = useProjectStripModel();
  const showNumbers = useShowProjectShortcutBadges();
  const clearProjectFilters = useSidebarViewStore((state) => state.clearProjectFilters);

  const handleDragEnd = useCallback((reordered: SidebarProjectEntry[]) => {
    saveProjectStripOrder(reordered.map((project) => project.viewKey));
  }, []);

  const renderItem = useCallback(
    ({ item, index }: DraggableRenderItemInfo<SidebarProjectEntry>) => (
      <RailProjectButton
        project={item}
        index={index}
        iconDataUri={model?.iconByViewKey.get(item.viewKey) ?? null}
        selected={model?.selectedKeys.has(item.viewKey) ?? false}
        showNumber={showNumbers}
      />
    ),
    [model?.iconByViewKey, model?.selectedKeys, showNumbers],
  );

  if (!model) return null;

  return (
    <View
      style={styles.rail}
      accessibilityRole="tablist"
      accessibilityLabel={t("sidebar.projectStrip.label")}
      testID="sidebar-project-rail"
    >
      <RailAllButton selected={model.allSelected} onPress={clearProjectFilters} />
      <View style={styles.railDivider} />
      <DraggableList
        testID="sidebar-project-rail-list"
        data={model.projects}
        keyExtractor={projectViewKeyExtractor}
        renderItem={renderItem}
        onDragEnd={handleDragEnd}
        extraData={model.selectedKeys}
        useDragHandle
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.railListContent}
      />
    </View>
  );
}

function projectViewKeyExtractor(project: SidebarProjectEntry): string {
  return project.viewKey;
}

function RailAllButton({ selected, onPress }: { selected: boolean; onPress: () => void }) {
  const { t } = useTranslation();
  const { hovered, onPointerEnter, onPointerLeave } = useHoverHandlers();
  const label = t("sidebar.projectStrip.allProjects");
  return (
    <View style={styles.railItem} onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave}>
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <PressHighlight
            accessibilityRole="tab"
            accessibilityLabel={label}
            aria-selected={selected}
            highlightStyle={styles.railButtonPressed}
            onPress={onPress}
            style={[
              styles.railButton,
              hovered && !selected ? styles.railButtonHovered : null,
              selected ? styles.railButtonSelected : null,
            ]}
            testID="sidebar-project-rail-all"
          >
            <View style={styles.railAllIcon}>
              <ThemedLayoutGrid size={16} uniProps={allIconMapping} />
            </View>
          </PressHighlight>
        </TooltipTrigger>
        <TooltipContent side="right" align="center" offset={8}>
          <Text style={styles.tooltipText}>{label}</Text>
        </TooltipContent>
      </Tooltip>
    </View>
  );
}

const RailProjectButton = memo(function RailProjectButton({
  project,
  index,
  iconDataUri,
  selected,
  showNumber,
}: {
  project: SidebarProjectEntry;
  index: number;
  iconDataUri: string | null;
  selected: boolean;
  showNumber: boolean;
}) {
  const { t } = useTranslation();
  const { hovered, onPointerEnter, onPointerLeave } = useHoverHandlers();
  const showOnlyProject = useSidebarViewStore((state) => state.showOnlyProject);
  const needsInputCount = useSidebarProjectNeedsInputCount(project.workspaces);
  const chord = useProjectJumpChord(index);
  const shortcutNumber = projectStripShortcutNumber(index);
  const handlePress = useCallback(
    () => showOnlyProject(project.viewKey),
    [project.viewKey, showOnlyProject],
  );
  const needsInputLabel =
    needsInputCount > 0 ? t("sidebar.projectStrip.needsInput", { count: needsInputCount }) : null;

  return (
    <View style={styles.railItem} onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave}>
      <DraggableListHandle
        accessibilityLabel={project.projectName}
        testID={`sidebar-project-rail-handle-${project.viewKey}`}
      >
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            <PressHighlight
              accessibilityRole="tab"
              accessibilityLabel={
                needsInputLabel ? `${project.projectName}, ${needsInputLabel}` : project.projectName
              }
              aria-selected={selected}
              highlightStyle={styles.railButtonPressed}
              onPress={handlePress}
              style={[
                styles.railButton,
                hovered && !selected ? styles.railButtonHovered : null,
                selected ? styles.railButtonSelected : null,
              ]}
              testID={`sidebar-project-rail-item-${project.viewKey}`}
            >
              <ProjectIconView
                iconDataUri={iconDataUri}
                initial={projectInitial(project.projectName)}
                projectViewKey={project.viewKey}
                size={RAIL_ICON_SIZE}
                textStyle={styles.railIconText}
              />
              {needsInputCount > 0 ? <NeedsInputBadge count={needsInputCount} floating /> : null}
              {showNumber && shortcutNumber !== null ? (
                <View
                  style={styles.railNumber}
                  pointerEvents="none"
                  testID="sidebar-project-rail-number"
                >
                  <SidebarWorkspaceShortcutBadge number={shortcutNumber} />
                </View>
              ) : null}
            </PressHighlight>
          </TooltipTrigger>
          <TooltipContent side="right" align="center" offset={8}>
            <View style={styles.tooltipRow}>
              <View>
                <Text style={styles.tooltipText}>{project.projectName}</Text>
                {needsInputLabel ? (
                  <Text style={styles.tooltipSubtext}>{needsInputLabel}</Text>
                ) : null}
              </View>
              {chord ? <Shortcut chord={chord} /> : null}
            </View>
          </TooltipContent>
        </Tooltip>
      </DraggableListHandle>
    </View>
  );
});

function NeedsInputBadge({ count, floating = false }: { count: number; floating?: boolean }) {
  return (
    <View
      style={[styles.needsInputBadge, floating ? styles.needsInputBadgeFloating : null]}
      pointerEvents="none"
      testID="sidebar-project-strip-needs-input"
    >
      <Text style={styles.needsInputBadgeText}>{count > 99 ? "99+" : count}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Compact: a horizontal chip row at the top of the sidebar
// ---------------------------------------------------------------------------

export function SidebarProjectChipRow({
  closeGestureRef,
}: {
  /** The sidebar's swipe-to-close pan. Sideways drags on the row scroll it instead. */
  closeGestureRef: RefObject<GestureType | undefined>;
}) {
  const { t } = useTranslation();
  const model = useProjectStripModel();
  const showNumbers = useShowProjectShortcutBadges();
  const clearProjectFilters = useSidebarViewStore((state) => state.clearProjectFilters);

  if (!model) return null;

  const chips = (
    <>
      <PressHighlight
        accessibilityRole="tab"
        aria-selected={model.allSelected}
        highlightStyle={styles.chipPressed}
        onPress={clearProjectFilters}
        style={[styles.chip, model.allSelected ? styles.chipSelected : null]}
        testID="sidebar-project-chip-all"
      >
        <Text style={styles.chipText}>{t("sidebar.projectStrip.all")}</Text>
      </PressHighlight>
      {model.projects.map((project, index) => (
        <ProjectChip
          key={project.viewKey}
          project={project}
          index={index}
          projectKeys={model.projectKeys}
          iconDataUri={model.iconByViewKey.get(project.viewKey) ?? null}
          selected={model.selectedKeys.has(project.viewKey)}
          showNumber={showNumbers}
        />
      ))}
    </>
  );

  return (
    <View
      style={styles.chipRowContainer}
      accessibilityRole="tablist"
      accessibilityLabel={t("sidebar.projectStrip.label")}
      testID="sidebar-project-chip-row"
    >
      {platformIsNative ? (
        <GHScrollView
          horizontal
          // The close pan waits for this scroll to fail, so a sideways drag on the
          // chips scrolls them instead of closing the sidebar.
          blocksHandlers={closeGestureRef}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipRowContent}
        >
          {chips}
        </GHScrollView>
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipRowContent}
        >
          {chips}
        </ScrollView>
      )}
    </View>
  );
}

const MOVE_LABEL_KEYS: Record<ProjectStripMove, string> = {
  first: "sidebar.projectStrip.moveFirst",
  earlier: "sidebar.projectStrip.moveEarlier",
  later: "sidebar.projectStrip.moveLater",
};

const ProjectChip = memo(function ProjectChip({
  project,
  index,
  projectKeys,
  iconDataUri,
  selected,
  showNumber,
}: {
  project: SidebarProjectEntry;
  index: number;
  projectKeys: string[];
  iconDataUri: string | null;
  selected: boolean;
  showNumber: boolean;
}) {
  const { t } = useTranslation();
  const showOnlyProject = useSidebarViewStore((state) => state.showOnlyProject);
  const needsInputCount = useSidebarProjectNeedsInputCount(project.workspaces);
  const shortcutNumber = projectStripShortcutNumber(index);
  const moves = listProjectStripMoves({ projectKeys, viewKey: project.viewKey });
  const handlePress = useCallback(
    () => showOnlyProject(project.viewKey),
    [project.viewKey, showOnlyProject],
  );
  const needsInputLabel =
    needsInputCount > 0 ? t("sidebar.projectStrip.needsInput", { count: needsInputCount }) : null;

  return (
    <ContextMenu>
      <ContextMenuTrigger
        accessibilityRole="tab"
        accessibilityLabel={
          needsInputLabel ? `${project.projectName}, ${needsInputLabel}` : project.projectName
        }
        aria-selected={selected}
        highlightStyle={styles.chipPressed}
        enabled={moves.length > 0}
        onPress={handlePress}
        style={[styles.chip, selected ? styles.chipSelected : null]}
        testID={`sidebar-project-chip-item-${project.viewKey}`}
      >
        {showNumber && shortcutNumber !== null ? (
          <SidebarWorkspaceShortcutBadge number={shortcutNumber} />
        ) : null}
        <ProjectIconView
          iconDataUri={iconDataUri}
          initial={projectInitial(project.projectName)}
          projectViewKey={project.viewKey}
          size={CHIP_ICON_SIZE}
          textStyle={styles.chipIconText}
        />
        <Text style={styles.chipText} numberOfLines={1}>
          {project.projectName}
        </Text>
        {needsInputCount > 0 ? <NeedsInputBadge count={needsInputCount} /> : null}
      </ContextMenuTrigger>
      <ContextMenuContent
        align="start"
        width={220}
        testID={`sidebar-project-chip-menu-${project.viewKey}`}
      >
        {moves.map((move) => (
          <ProjectChipMoveItem
            key={move}
            move={move}
            projectKeys={projectKeys}
            viewKey={project.viewKey}
          />
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
});

function ProjectChipMoveItem({
  move,
  projectKeys,
  viewKey,
}: {
  move: ProjectStripMove;
  projectKeys: string[];
  viewKey: string;
}) {
  const { t } = useTranslation();
  const handleSelect = useCallback(
    () => saveProjectStripOrder(moveProjectStripEntry({ projectKeys, viewKey, move })),
    [move, projectKeys, viewKey],
  );
  return (
    <ContextMenuItem onSelect={handleSelect} testID={`sidebar-project-chip-move-${move}`}>
      {t(MOVE_LABEL_KEYS[move])}
    </ContextMenuItem>
  );
}

const styles = StyleSheet.create((theme) => ({
  railLayout: {
    flex: 1,
    minHeight: 0,
    flexDirection: "row",
  },
  railLayoutMain: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
  },
  rail: {
    width: 52,
    flexShrink: 0,
    alignItems: "stretch",
    paddingTop: theme.spacing[2],
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
  },
  railDivider: {
    height: 1,
    marginHorizontal: theme.spacing[3],
    marginVertical: theme.spacing[1],
    backgroundColor: theme.colors.border,
  },
  railListContent: {
    paddingBottom: theme.spacing[2],
  },
  railItem: {
    position: "relative",
    alignItems: "center",
    paddingVertical: 2,
  },
  railButton: {
    position: "relative",
    width: 38,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.lg,
    borderWidth: 2,
    borderColor: "transparent",
  },
  railButtonHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  railButtonSelected: {
    backgroundColor: theme.colors.surfaceSidebarSelected,
    borderColor: theme.colors.accent,
  },
  railButtonPressed: {
    backgroundColor: theme.colors.surface2,
  },
  railAllIcon: {
    width: RAIL_ICON_SIZE,
    height: RAIL_ICON_SIZE,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
  },
  railIconText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  railNumber: {
    position: "absolute",
    left: -4,
    bottom: -4,
  },
  needsInputBadge: {
    minWidth: 16,
    height: 16,
    paddingHorizontal: 4,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.full,
    backgroundColor: getStatusDotColor({ theme, bucket: "needs_input" }) ?? theme.colors.accent,
  },
  needsInputBadgeFloating: {
    position: "absolute",
    top: -5,
    right: -5,
    borderWidth: 2,
    borderColor: theme.colors.surfaceSidebar,
    height: 20,
    minWidth: 20,
  },
  needsInputBadgeText: {
    color: theme.colors.surface0,
    fontSize: 10,
    fontWeight: theme.fontWeight.semibold,
    lineHeight: 12,
  },
  tooltipRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  tooltipText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.popoverForeground,
  },
  tooltipSubtext: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  chipRowContainer: {
    flexShrink: 0,
  },
  chipRowContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  chip: {
    height: 32,
    maxWidth: 200,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  chipSelected: {
    backgroundColor: theme.colors.surfaceSidebarSelected,
    borderColor: theme.colors.accent,
  },
  chipPressed: {
    backgroundColor: theme.colors.surface2,
  },
  chipIconText: {
    fontSize: 10,
    fontWeight: theme.fontWeight.semibold,
  },
  chipText: {
    flexShrink: 1,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
}));
