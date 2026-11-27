import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Ellipsis,
  GripVertical,
  Inbox,
  LayoutGrid,
} from "lucide-react-native";
import {
  memo,
  type ReactElement,
  type ReactNode,
  type RefObject,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { router, usePathname, type Href } from "expo-router";
import { type LayoutChangeEvent, ScrollView, Text, View } from "react-native";
import { Gesture, GestureDetector, type GestureType } from "react-native-gesture-handler";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { DraggableList, DraggableListHandle } from "@/components/draggable-list";
import type { DraggableRenderItemInfo } from "@/components/draggable-list.types";
import { ProjectIconView } from "@/components/project-icon-view";
import { resolveProjectLastChat } from "@/components/sidebar/project-last-chat";
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
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { ProjectPeek } from "@/needs-you/project-peek";
import { isNative as platformIsNative } from "@/constants/platform";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { useShowProjectShortcutBadges } from "@/hooks/use-show-shortcut-badges";
import {
  type SidebarProjectEntry,
  useSidebarProjectStatusCounts,
} from "@/hooks/use-sidebar-workspaces-list";
import type { ProjectStatusCounts } from "@/hooks/sidebar-workspaces-view-model";
import {
  ProjectStatusCountList,
  ProjectStatusDots,
  useProjectStatusLabel,
} from "./project-status-dots";
import { useNeedsYouCount } from "@/needs-you/use-needs-you";
import { useProjectIcons } from "@/projects/icons";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { usePanelStore } from "@/stores/panel-store";
import { useSidebarLastChatStore } from "@/stores/sidebar-last-chat-store";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import { useSidebarRailOpenStore } from "@/stores/sidebar-rail-open-store";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import { useSidebarQuietFoldStore } from "@/stores/sidebar-quiet-fold-store";
import type { Theme } from "@/styles/theme";
import type { ShortcutKey } from "@/utils/format-shortcut";
import { projectIconPlaceholderLabelFromDisplayName } from "@/utils/project-display-name";
import { buildNeedsYouRoute } from "@/utils/host-routes";
import { resolveSidebarProjectIconTargets } from "@/utils/sidebar-project-row-model";
import { hasVisibleOrderChanged, mergeWithRemainder } from "@/utils/sidebar-reorder";
import {
  listProjectEndMoves,
  listProjectStripMoves,
  moveProjectStripEntry,
  type ProjectStripMove,
  projectStripShortcutNumber,
  shouldShowProjectStrip,
} from "./project-strip-model";

const RAIL_WIDTH = 52;
/** The open rail: room for a project name beside its icon, over the sidebar's own column. */
const RAIL_OPEN_WIDTH = 220;
const RAIL_ICON_SIZE = 28;
const CHIP_ICON_SIZE = 18;
/** The chip row's left and right padding; theme spacing 3. */
const CHIP_ROW_INSET = 12;
const PROJECT_JUMP_HELP_ID = "sidebar-project-jump-index";

const ThemedLayoutGrid = withUnistyles(LayoutGrid);
const ThemedEllipsis = withUnistyles(Ellipsis);
const ThemedChevronLeft = withUnistyles(ChevronLeft);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedChevronsLeft = withUnistyles(ChevronsLeft);
const ThemedChevronsRight = withUnistyles(ChevronsRight);
const ThemedGripVertical = withUnistyles(GripVertical);
const ThemedInbox = withUnistyles(Inbox);
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
  /** The projects that show; `quietProjects` sit behind "More". */
  projects: SidebarProjectEntry[];
  quietProjects: SidebarProjectEntry[];
  projectKeys: string[];
  iconByViewKey: ReadonlyMap<string, string | null>;
  allSelected: boolean;
  selectedKeys: ReadonlySet<string>;
}

function useProjectStripModel(): ProjectStripModel | null {
  const { allProjects, resolvedProjectFilters, stripProjects } = useSidebarModel();
  const iconTargets = useMemo(() => resolveSidebarProjectIconTargets(allProjects), [allProjects]);
  const iconByViewKey = useProjectIcons({ projects: iconTargets });
  const projectKeys = useMemo(() => allProjects.map((project) => project.viewKey), [allProjects]);
  const selectedKeys = useMemo(() => new Set(resolvedProjectFilters), [resolvedProjectFilters]);
  if (!shouldShowProjectStrip(allProjects.length)) return null;
  return {
    projects: stripProjects.active,
    quietProjects: stripProjects.quiet,
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
  const open = useSidebarRailOpenStore((state) => state.open);

  const handleDragEnd = useCallback((reordered: SidebarProjectEntry[]) => {
    saveProjectStripOrder(reordered.map((project) => project.viewKey));
  }, []);

  const renderItem = useCallback(
    ({ item, index }: DraggableRenderItemInfo<SidebarProjectEntry>) => (
      <RailProjectButton
        project={item}
        index={index}
        projectKeys={model?.projectKeys ?? EMPTY_KEYS}
        iconDataUri={model?.iconByViewKey.get(item.viewKey) ?? null}
        selected={model?.selectedKeys.has(item.viewKey) ?? false}
        showNumber={showNumbers}
        open={open}
      />
    ),
    [model?.iconByViewKey, model?.projectKeys, model?.selectedKeys, open, showNumbers],
  );
  const extraData = useMemo(
    () => ({ selectedKeys: model?.selectedKeys, open }),
    [model?.selectedKeys, open],
  );

  const quietFooter = useMemo(
    () =>
      model && model.quietProjects.length > 0 ? (
        <RailQuietFold
          projects={model.quietProjects}
          startIndex={model.projects.length}
          projectKeys={model.projectKeys}
          iconByViewKey={model.iconByViewKey}
          selectedKeys={model.selectedKeys}
          showNumber={showNumbers}
          open={open}
        />
      ) : null,
    [model, open, showNumbers],
  );

  if (!model) return null;

  return (
    <>
      {/* Open, the rail lies over the sidebar; the spacer keeps the sidebar's column in place. */}
      {open ? <View style={styles.railSpacer} /> : null}
      <View
        style={[styles.rail, open ? styles.railOpen : null]}
        accessibilityRole="tablist"
        accessibilityLabel={t("sidebar.projectStrip.label")}
        testID="sidebar-project-rail"
      >
        <RailOpenToggle open={open} />
        <RailNeedsYouButton open={open} />
        <RailAllButton selected={model.allSelected} onPress={clearProjectFilters} open={open} />
        <View style={styles.railDivider} />
        <DraggableList
          testID="sidebar-project-rail-list"
          data={model.projects}
          keyExtractor={projectViewKeyExtractor}
          renderItem={renderItem}
          onDragEnd={handleDragEnd}
          extraData={extraData}
          ListFooterComponent={quietFooter}
          useDragHandle
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.railListContent}
        />
      </View>
    </>
  );
}

const EMPTY_KEYS: string[] = [];

/** A tooltip on the closed rail, where icons carry no names. The open rail writes them out. */
function RailTooltip({
  show,
  label,
  subtext,
  chord,
  children,
}: {
  show: boolean;
  label: string;
  subtext?: string | null;
  chord?: ShortcutKey[][] | null;
  children: ReactElement;
}) {
  if (!show) return children;
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right" align="center" offset={8}>
        <View style={styles.tooltipRow}>
          <View>
            <Text style={styles.tooltipText}>{label}</Text>
            {subtext ? <Text style={styles.tooltipSubtext}>{subtext}</Text> : null}
          </View>
          {chord ? <Shortcut chord={chord} /> : null}
        </View>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * A rail project's hover: its waiting question when one waits (peek, owner decision Q94), else
 * the name tooltip. The peek is a hover card, so the pointer can cross onto it to answer.
 */
function RailPeek({
  project,
  waiting,
  open,
  label,
  subtext,
  chord,
  children,
}: {
  project: SidebarProjectEntry;
  waiting: boolean;
  open: boolean;
  label: string;
  subtext?: string | null;
  chord?: ShortcutKey[][] | null;
  children: ReactElement;
}) {
  // A peek that is sending or showing "Sent" stays up after the project stops waiting.
  const [held, setHeld] = useState(false);
  if (!waiting && !held) {
    return (
      <RailTooltip show={!open} label={label} subtext={subtext} chord={chord}>
        {children}
      </RailTooltip>
    );
  }
  return (
    <HoverCard>
      <HoverCardTrigger>{children}</HoverCardTrigger>
      <HoverCardContent placement="right" alignment="start" offset={8}>
        <ProjectPeek
          hosts={project.hosts}
          onHoldChange={setHeld}
          testID={`sidebar-project-rail-peek-${project.viewKey}`}
        />
      </HoverCardContent>
    </HoverCard>
  );
}

/** The rail's first button: » opens the rail over the sidebar, « Collapse closes it. */
function RailOpenToggle({ open }: { open: boolean }) {
  // Keyed by state: the toggle changes size under a still pointer, which fires no pointerleave,
  // so a fresh hover state per open/closed keeps the old hover from sticking.
  return <RailOpenToggleButton key={open ? "open" : "closed"} open={open} />;
}

function RailOpenToggleButton({ open }: { open: boolean }) {
  const { t } = useTranslation();
  const { hovered, onPointerEnter, onPointerLeave } = useHoverHandlers();
  const setOpen = useSidebarRailOpenStore((state) => state.setOpen);
  const handlePress = useCallback(() => setOpen(!open), [open, setOpen]);
  const label = open ? t("sidebar.projectStrip.collapseRail") : t("sidebar.projectStrip.openRail");
  return (
    <View
      style={[styles.railItem, open ? styles.railItemOpen : null]}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <RailTooltip show={!open} label={label}>
        <PressHighlight
          accessibilityRole="button"
          accessibilityLabel={label}
          aria-expanded={open}
          highlightStyle={styles.railButtonPressed}
          onPress={handlePress}
          style={[
            open ? styles.railRow : styles.railToggleButton,
            hovered ? styles.railButtonHovered : null,
          ]}
          testID="sidebar-project-rail-toggle"
        >
          <View style={styles.railToggleIcon}>
            {open ? (
              <ThemedChevronsLeft size={16} uniProps={allIconMapping} />
            ) : (
              <ThemedChevronsRight size={16} uniProps={allIconMapping} />
            )}
          </View>
          {open ? <Text style={styles.railRowMutedText}>{label}</Text> : null}
        </PressHighlight>
      </RailTooltip>
    </View>
  );
}

/**
 * The rail's "More": projects with no chat activity for 3 days. Opening it lists them under
 * it; they don't drag, since the drag order is the order of the projects that show.
 */
function RailQuietFold({
  projects,
  startIndex,
  projectKeys,
  iconByViewKey,
  selectedKeys,
  showNumber,
  open,
}: {
  projects: SidebarProjectEntry[];
  startIndex: number;
  projectKeys: string[];
  iconByViewKey: ReadonlyMap<string, string | null>;
  selectedKeys: ReadonlySet<string>;
  showNumber: boolean;
  open: boolean;
}) {
  const { t } = useTranslation();
  const { hovered, onPointerEnter, onPointerLeave } = useHoverHandlers();
  const foldOpen = useSidebarQuietFoldStore((state) => state.open);
  const toggle = useSidebarQuietFoldStore((state) => state.toggle);
  const label = t("sidebar.projectStrip.quietMore", { count: projects.length });
  return (
    <View testID="sidebar-project-rail-quiet">
      <View style={styles.railDivider} />
      <View
        style={[styles.railItem, open ? styles.railItemOpen : null]}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
      >
        <RailTooltip show={!open} label={label}>
          <PressHighlight
            accessibilityRole="button"
            accessibilityLabel={label}
            aria-expanded={foldOpen}
            highlightStyle={styles.railButtonPressed}
            onPress={toggle}
            style={[
              open ? styles.railRow : styles.railButton,
              hovered || foldOpen ? styles.railButtonHovered : null,
            ]}
            testID="sidebar-project-rail-more"
          >
            <View style={styles.railAllIcon}>
              <ThemedEllipsis size={16} uniProps={allIconMapping} />
            </View>
            {open ? (
              <Text style={styles.railRowMutedText} numberOfLines={1}>
                {label}
              </Text>
            ) : (
              <View style={styles.quietCountFloating} pointerEvents="none">
                <Text style={styles.quietCountText}>{projects.length}</Text>
              </View>
            )}
          </PressHighlight>
        </RailTooltip>
      </View>
      {foldOpen
        ? projects.map((project, index) => (
            <RailProjectButton
              key={project.viewKey}
              project={project}
              index={startIndex + index}
              projectKeys={projectKeys}
              iconDataUri={iconByViewKey.get(project.viewKey) ?? null}
              selected={selectedKeys.has(project.viewKey)}
              showNumber={showNumber}
              open={open}
            />
          ))
        : null}
    </View>
  );
}

function projectViewKeyExtractor(project: SidebarProjectEntry): string {
  return project.viewKey;
}

function RailAllButton({
  selected,
  onPress,
  open,
}: {
  selected: boolean;
  onPress: () => void;
  open: boolean;
}) {
  const { t } = useTranslation();
  const { hovered, onPointerEnter, onPointerLeave } = useHoverHandlers();
  const label = t("sidebar.projectStrip.allProjects");
  return (
    <View
      style={[styles.railItem, open ? styles.railItemOpen : null]}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <RailTooltip show={!open} label={label}>
        <PressHighlight
          accessibilityRole="tab"
          accessibilityLabel={label}
          aria-selected={selected}
          highlightStyle={styles.railButtonPressed}
          onPress={onPress}
          style={[
            open ? styles.railRow : styles.railButton,
            hovered && !selected ? styles.railButtonHovered : null,
            selected ? styles.railButtonSelected : null,
          ]}
          testID="sidebar-project-rail-all"
        >
          <View style={styles.railAllIcon}>
            <ThemedLayoutGrid size={16} uniProps={allIconMapping} />
          </View>
          {open ? (
            <Text style={styles.railRowText} numberOfLines={1}>
              {label}
            </Text>
          ) : null}
        </PressHighlight>
      </RailTooltip>
    </View>
  );
}

/** The count on Needs you: "9+" past nine. */
function needsYouBadgeText(count: number): string {
  return count > 9 ? "9+" : String(count);
}

function useOpenNeedsYou(beforeOpen?: () => void) {
  const pathname = usePathname();
  const selected = pathname === buildNeedsYouRoute();
  const open = useCallback(() => {
    beforeOpen?.();
    // Typed routes come from Metro's generated router.d.ts; a copy older than this route would
    // reject the literal, so cast like the other route builders' callers.
    router.push(buildNeedsYouRoute() as Href);
  }, [beforeOpen]);
  return { selected, open };
}

/**
 * Needs you, above All (owner decisions Q91, Q98): every chat waiting on you, on one page. The
 * purple number counts those chats plus what plugins add, such as late tasks.
 */
function RailNeedsYouButton({ open }: { open: boolean }) {
  const { t } = useTranslation();
  const { hovered, onPointerEnter, onPointerLeave } = useHoverHandlers();
  const count = useNeedsYouCount();
  const { selected, open: openNeedsYou } = useOpenNeedsYou();
  const label = t("needsYou.title");
  return (
    <View
      style={[styles.railItem, open ? styles.railItemOpen : null]}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <RailTooltip show={!open} label={label}>
        <PressHighlight
          accessibilityRole="button"
          accessibilityLabel={t("needsYou.railLabel", { count })}
          aria-selected={selected}
          highlightStyle={styles.railButtonPressed}
          onPress={openNeedsYou}
          style={[
            open ? styles.railRow : styles.railButton,
            hovered && !selected ? styles.railButtonHovered : null,
            selected ? styles.railButtonSelected : null,
          ]}
          testID="sidebar-project-rail-needs-you"
        >
          <View style={styles.railAllIcon}>
            <ThemedInbox size={16} uniProps={allIconMapping} />
          </View>
          {open ? (
            <Text style={styles.railRowText} numberOfLines={1}>
              {label}
            </Text>
          ) : null}
          {count > 0 ? (
            <View
              style={open ? styles.needsYouCount : styles.needsYouCountFloating}
              pointerEvents="none"
              testID="sidebar-needs-you-count"
            >
              <Text style={styles.needsYouCountText}>{needsYouBadgeText(count)}</Text>
            </View>
          ) : null}
        </PressHighlight>
      </RailTooltip>
    </View>
  );
}

/** The phone's Needs you: the first chip in the row, before All. Opening it closes the sidebar. */
function NeedsYouChip() {
  const { t } = useTranslation();
  const count = useNeedsYouCount();
  const closeSidebar = usePanelStore((state) => state.showMobileAgent);
  const { selected, open } = useOpenNeedsYou(closeSidebar);
  return (
    <PressHighlight
      accessibilityRole="button"
      accessibilityLabel={t("needsYou.railLabel", { count })}
      aria-selected={selected}
      highlightStyle={styles.chipPressed}
      onPress={open}
      style={[styles.chip, selected ? styles.chipSelected : null]}
      testID="sidebar-project-chip-needs-you"
    >
      <ThemedInbox size={14} uniProps={allIconMapping} />
      <Text style={styles.chipText}>{t("needsYou.title")}</Text>
      {count > 0 ? (
        <View style={styles.needsYouCount} testID="sidebar-needs-you-chip-count">
          <Text style={styles.needsYouCountText}>{needsYouBadgeText(count)}</Text>
        </View>
      ) : null}
    </PressHighlight>
  );
}

const RailProjectButton = memo(function RailProjectButton({
  project,
  index,
  projectKeys,
  iconDataUri,
  selected,
  showNumber,
  open,
}: {
  project: SidebarProjectEntry;
  index: number;
  projectKeys: string[];
  iconDataUri: string | null;
  selected: boolean;
  showNumber: boolean;
  /** The open rail: a row with the name beside the icon, instead of the icon alone. */
  open: boolean;
}) {
  const { t } = useTranslation();
  const { hovered, onPointerEnter, onPointerLeave } = useHoverHandlers();
  const showOnlyProject = useSidebarViewStore((state) => state.showOnlyProject);
  const setRailOpen = useSidebarRailOpenStore((state) => state.setOpen);
  const statusCounts = useSidebarProjectStatusCounts(project.workspaces);
  const statusLabel = useProjectStatusLabel(statusCounts);
  const chord = useProjectJumpChord(index);
  const shortcutNumber = projectStripShortcutNumber(index);
  const rememberedChat = useSidebarLastChatStore((state) => state.byProject[project.viewKey]);
  const moves = listProjectEndMoves({ projectKeys, viewKey: project.viewKey });
  // The rail sits beside the open chat, so a click goes back to where you were in that project.
  const handlePress = useCallback(() => {
    showOnlyProject(project.viewKey);
    const lastChat = resolveProjectLastChat(project, rememberedChat);
    if (lastChat) navigateToWorkspace(lastChat);
  }, [project, rememberedChat, showOnlyProject]);
  const handleReorder = useCallback(() => setRailOpen(true), [setRailOpen]);

  return (
    <View
      style={[styles.railItem, open ? styles.railItemOpen : null]}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <ContextMenu>
        <ContextMenuTrigger contextOnly>
          <DraggableListHandle
            accessibilityLabel={project.projectName}
            testID={`sidebar-project-rail-handle-${project.viewKey}`}
          >
            <RailPeek
              project={project}
              waiting={statusCounts.needsInput > 0}
              open={open}
              label={project.projectName}
              subtext={statusLabel}
              chord={chord}
            >
              <PressHighlight
                accessibilityRole="tab"
                accessibilityLabel={
                  statusLabel ? `${project.projectName}, ${statusLabel}` : project.projectName
                }
                aria-selected={selected}
                highlightStyle={styles.railButtonPressed}
                onPress={handlePress}
                style={[
                  open ? styles.railRow : styles.railButton,
                  hovered && !selected ? styles.railButtonHovered : null,
                  selected ? styles.railButtonSelected : null,
                ]}
                testID={`sidebar-project-rail-item-${project.viewKey}`}
              >
                <RailProjectFace
                  project={project}
                  iconDataUri={iconDataUri}
                  open={open}
                  statusCounts={statusCounts}
                  shortcutNumber={showNumber ? shortcutNumber : null}
                />
              </PressHighlight>
            </RailPeek>
          </DraggableListHandle>
        </ContextMenuTrigger>
        <ContextMenuContent
          align="start"
          width={220}
          testID={`sidebar-project-rail-menu-${project.viewKey}`}
        >
          {moves.map((move) => (
            <ProjectMoveItem
              key={move}
              move={move}
              projectKeys={projectKeys}
              viewKey={project.viewKey}
              testIDPrefix="sidebar-project-rail-move"
            />
          ))}
          {/* On the desktop you reorder by dragging on the open rail. */}
          {open ? null : (
            <ContextMenuItem onSelect={handleReorder} testID="sidebar-project-rail-reorder">
              {t("sidebar.projectStrip.reorderProjects")}
            </ContextMenuItem>
          )}
        </ContextMenuContent>
      </ContextMenu>
    </View>
  );
});

/**
 * What a rail project button shows: the icon with a dot per busy chat; open, the name, the exact
 * counts and a grip.
 */
function RailProjectFace({
  project,
  iconDataUri,
  open,
  statusCounts,
  shortcutNumber,
}: {
  project: SidebarProjectEntry;
  iconDataUri: string | null;
  open: boolean;
  statusCounts: ProjectStatusCounts;
  shortcutNumber: number | null;
}) {
  return (
    <>
      <ProjectIconView
        iconDataUri={iconDataUri}
        initial={projectInitial(project.projectName)}
        projectViewKey={project.viewKey}
        size={RAIL_ICON_SIZE}
        textStyle={styles.railIconText}
      />
      {open ? (
        <>
          <Text style={styles.railRowText} numberOfLines={1}>
            {project.projectName}
          </Text>
          <ProjectStatusCountList counts={statusCounts} />
          <ThemedGripVertical size={14} uniProps={allIconMapping} />
        </>
      ) : (
        <ProjectStatusDots counts={statusCounts} direction="column" />
      )}
      {shortcutNumber !== null ? (
        <View style={styles.railNumber} pointerEvents="none" testID="sidebar-project-rail-number">
          <SidebarWorkspaceShortcutBadge number={shortcutNumber} />
        </View>
      ) : null}
    </>
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
  // The close pan waits for this scroll to fail, so a sideways drag on the chips scrolls them
  // instead of closing the sidebar. The relation lives on a Native gesture: the gesture-handler
  // ScrollView's blocksHandlers prop reaches native unconverted, and copying the close pan's ref
  // through it ran Android out of memory at launch.
  // Android's Native gesture cancels itself when the finger leaves the view, which freed the
  // waiting close pan mid-drag: a drag that slid down off the row onto the list closed the
  // sidebar. Keeping it alive outside the row makes the drag the row's until the finger lifts.
  const chipScrollGesture = useMemo(
    () => Gesture.Native().shouldCancelWhenOutside(false).blocksExternalGesture(closeGestureRef),
    [closeGestureRef],
  );
  const chipScrollRef = useRef<ScrollView>(null);

  if (!model) return null;

  const chips = (
    <>
      <NeedsYouChip />
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
      {model.quietProjects.length > 0 ? (
        <QuietChips model={model} showNumber={showNumbers} scrollRef={chipScrollRef} />
      ) : null}
    </>
  );

  const chipScroll = (
    <ScrollView
      ref={chipScrollRef}
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.chipRowContent}
    >
      {chips}
    </ScrollView>
  );

  return (
    <View
      style={styles.chipRowContainer}
      accessibilityRole="tablist"
      accessibilityLabel={t("sidebar.projectStrip.label")}
      testID="sidebar-project-chip-row"
    >
      {platformIsNative ? (
        <GestureDetector gesture={chipScrollGesture}>{chipScroll}</GestureDetector>
      ) : (
        chipScroll
      )}
    </View>
  );
}

/**
 * The chip row's "More": a chip that opens the quiet projects as chips after it. "More" sits at
 * the row's end, so the opened chips land past the right edge; opening scrolls the row to show
 * them, or the tap looks like it did nothing.
 */
function QuietChips({
  model,
  showNumber,
  scrollRef,
}: {
  model: ProjectStripModel;
  showNumber: boolean;
  scrollRef: RefObject<ScrollView | null>;
}) {
  const { t } = useTranslation();
  const open = useSidebarQuietFoldStore((state) => state.open);
  const toggle = useSidebarQuietFoldStore((state) => state.toggle);
  const moreXRef = useRef(0);
  const revealRef = useRef(false);
  const handleMoreLayout = useCallback((event: LayoutChangeEvent) => {
    moreXRef.current = event.nativeEvent.layout.x;
  }, []);
  const handlePress = useCallback(() => {
    revealRef.current = !open;
    toggle();
  }, [open, toggle]);
  // Runs once the opened chips have laid out, so the row's content is already wide enough to
  // scroll to. "More" lands at the row's left inset with the quiet chips after it.
  const handleQuietLayout = useCallback(() => {
    if (!revealRef.current) return;
    revealRef.current = false;
    scrollRef.current?.scrollTo({
      x: Math.max(0, moreXRef.current - CHIP_ROW_INSET),
      animated: true,
    });
  }, [scrollRef]);
  return (
    <>
      <PressHighlight
        accessibilityRole="button"
        aria-expanded={open}
        highlightStyle={styles.chipPressed}
        onLayout={handleMoreLayout}
        onPress={handlePress}
        style={[styles.chip, open ? styles.chipOpen : null]}
        testID="sidebar-project-chip-more"
      >
        <ThemedEllipsis size={14} uniProps={allIconMapping} />
        <Text style={styles.chipMutedText} numberOfLines={1}>
          {t("sidebar.projectStrip.quietMore", { count: model.quietProjects.length })}
        </Text>
        {open ? (
          <ThemedChevronLeft size={14} uniProps={allIconMapping} />
        ) : (
          <ThemedChevronRight size={14} uniProps={allIconMapping} />
        )}
      </PressHighlight>
      {open ? (
        <View style={styles.quietChips} onLayout={handleQuietLayout}>
          {model.quietProjects.map((project, index) => (
            <ProjectChip
              key={project.viewKey}
              project={project}
              index={model.projects.length + index}
              projectKeys={model.projectKeys}
              iconDataUri={model.iconByViewKey.get(project.viewKey) ?? null}
              selected={model.selectedKeys.has(project.viewKey)}
              showNumber={showNumber}
            />
          ))}
        </View>
      ) : null}
    </>
  );
}

const MOVE_LABEL_KEYS: Record<ProjectStripMove, string> = {
  top: "sidebar.projectStrip.moveTop",
  earlier: "sidebar.projectStrip.moveEarlier",
  later: "sidebar.projectStrip.moveLater",
  bottom: "sidebar.projectStrip.moveBottom",
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
  const showOnlyProject = useSidebarViewStore((state) => state.showOnlyProject);
  const statusCounts = useSidebarProjectStatusCounts(project.workspaces);
  const statusLabel = useProjectStatusLabel(statusCounts);
  // A peek that is sending or showing "Sent" stays up after the project stops waiting.
  const [peekHeld, setPeekHeld] = useState(false);
  const waiting = statusCounts.needsInput > 0 || peekHeld;
  const shortcutNumber = projectStripShortcutNumber(index);
  const moves = listProjectStripMoves({ projectKeys, viewKey: project.viewKey });
  const handlePress = useCallback(
    () => showOnlyProject(project.viewKey),
    [project.viewKey, showOnlyProject],
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger
        accessibilityRole="tab"
        accessibilityLabel={
          statusLabel ? `${project.projectName}, ${statusLabel}` : project.projectName
        }
        aria-selected={selected}
        highlightStyle={styles.chipPressed}
        enabled={moves.length > 0 || waiting}
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
        <ProjectStatusDots counts={statusCounts} direction="row" />
      </ContextMenuTrigger>
      <ContextMenuContent
        align="start"
        width={220}
        testID={`sidebar-project-chip-menu-${project.viewKey}`}
      >
        {/* Hold a waiting project's chip to answer its question without leaving the chat. */}
        {waiting ? (
          <ProjectPeek
            hosts={project.hosts}
            onHoldChange={setPeekHeld}
            testID={`sidebar-project-chip-peek-${project.viewKey}`}
          />
        ) : null}
        {moves.map((move) => (
          <ProjectMoveItem
            key={move}
            move={move}
            projectKeys={projectKeys}
            viewKey={project.viewKey}
            testIDPrefix="sidebar-project-chip-move"
          />
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
});

function ProjectMoveItem({
  move,
  projectKeys,
  viewKey,
  testIDPrefix,
}: {
  move: ProjectStripMove;
  projectKeys: string[];
  viewKey: string;
  testIDPrefix: string;
}) {
  const { t } = useTranslation();
  const handleSelect = useCallback(
    () => saveProjectStripOrder(moveProjectStripEntry({ projectKeys, viewKey, move })),
    [move, projectKeys, viewKey],
  );
  return (
    <ContextMenuItem onSelect={handleSelect} testID={`${testIDPrefix}-${move}`}>
      {t(MOVE_LABEL_KEYS[move])}
    </ContextMenuItem>
  );
}

const styles = StyleSheet.create((theme) => ({
  railLayout: {
    position: "relative",
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
    width: RAIL_WIDTH,
    flexShrink: 0,
    alignItems: "stretch",
    paddingTop: theme.spacing[2],
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
  },
  railSpacer: {
    width: RAIL_WIDTH,
    flexShrink: 0,
  },
  railOpen: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: RAIL_OPEN_WIDTH,
    maxWidth: "100%",
    zIndex: 10,
    backgroundColor: theme.colors.surfaceSidebar,
    ...theme.shadow.md,
  },
  railItemOpen: {
    alignItems: "stretch",
    paddingHorizontal: theme.spacing[1.5],
  },
  railRow: {
    position: "relative",
    height: 38,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[1],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 2,
    borderColor: "transparent",
  },
  railRowText: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  railRowMutedText: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  railToggleButton: {
    width: 38,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.lg,
  },
  railToggleIcon: {
    width: RAIL_ICON_SIZE,
    alignItems: "center",
    justifyContent: "center",
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
  quietCountFloating: {
    position: "absolute",
    top: -5,
    right: -5,
    minWidth: 20,
    height: 20,
    paddingHorizontal: 4,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.full,
    borderWidth: 2,
    borderColor: theme.colors.surfaceSidebar,
    backgroundColor: theme.colors.surface2,
  },
  quietCountText: {
    color: theme.colors.foregroundMuted,
    fontSize: 10,
    fontWeight: theme.fontWeight.semibold,
    lineHeight: 12,
  },
  needsYouCount: {
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.palette.purple[500],
  },
  needsYouCountFloating: {
    position: "absolute",
    top: -5,
    right: -5,
    minWidth: 20,
    height: 20,
    paddingHorizontal: 4,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.full,
    borderWidth: 2,
    borderColor: theme.colors.surfaceSidebar,
    backgroundColor: theme.colors.palette.purple[500],
  },
  needsYouCountText: {
    color: theme.colors.palette.white,
    fontSize: 10,
    fontWeight: theme.fontWeight.semibold,
    lineHeight: 12,
  },
  quietChips: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
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
  chipOpen: {
    backgroundColor: theme.colors.surfaceSidebarHover,
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
  chipMutedText: {
    flexShrink: 1,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
}));
