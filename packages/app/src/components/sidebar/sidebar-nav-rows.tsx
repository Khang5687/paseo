import { router, usePathname } from "expo-router";
import { CalendarClock, History, NotebookPen, Plus, Search } from "lucide-react-native";
import {
  memo,
  useCallback,
  useMemo,
  useRef,
  type ComponentType,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { SidebarNavIconRowContext } from "@/components/sidebar/sidebar-nav-icon-button";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { PluginSidebarItem } from "@/plugins/sidebar-items";
import { canCreateWorktreeForProjectKind } from "@/projects/host-projects";
import { useHostFeature } from "@/runtime/host-features";
import {
  builtinSidebarNavLabelKey,
  builtinSidebarNavShortcutAction,
  type BuiltinSidebarNavId,
  type SidebarNavItem,
} from "@/sidebar-nav/model";
import { useSidebarNavItems } from "@/sidebar-nav/use-sidebar-nav-items";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useWorkspace } from "@/stores/session-store-hooks";
import {
  buildNewWorkspaceRoute,
  buildNotesRoute,
  buildSchedulesRoute,
  buildSessionsRoute,
} from "@/utils/host-routes";

interface SidebarNavRowProps {
  onBeforeNavigate?: () => void;
}

interface SidebarNavRowsProps extends SidebarNavRowProps {
  /** Style for the group wrapper, which the sidebar owns. */
  style?: StyleProp<ViewStyle>;
}

/** The top-level items the user keeps visible, in display order. */
export function useVisibleSidebarNavItems() {
  const { items } = useSidebarNavItems("header");
  return useMemo(() => items.filter((item) => item.visible), [items]);
}

function renderNavItem(
  item: SidebarNavItem<"header">,
  groupRef: RefObject<View | null>,
  onBeforeNavigate: (() => void) | undefined,
): ReactElement {
  if (item.kind === "plugin") {
    return (
      <PluginSidebarItem
        key={item.key}
        group={item.group}
        section="header"
        fallbackAnchorRef={groupRef}
        onBeforeNavigate={onBeforeNavigate}
      />
    );
  }
  const Row = BUILTIN_ROWS[item.id];
  return <Row key={item.key} onBeforeNavigate={onBeforeNavigate} />;
}

/**
 * Top-level sidebar navigation, ordered and filtered by the user's
 * `sidebarNavItems` preference. Renders nothing — not even the bordered group
 * wrapper — when every item is hidden.
 */
export function SidebarNavRows({ style, onBeforeNavigate }: SidebarNavRowsProps) {
  const visibleItems = useVisibleSidebarNavItems();
  const groupRef = useRef<View | null>(null);

  if (visibleItems.length === 0) return null;

  return (
    <View ref={groupRef} collapsable={false} style={style}>
      {visibleItems.map((item) => renderNavItem(item, groupRef, onBeforeNavigate))}
    </View>
  );
}

/**
 * The compact layout's top navigation: the same items as `SidebarNavRows`, drawn as one row of
 * round icon buttons with `trailing` (the close button) at the right. Long-pressing a button
 * names it and leads to the list where the user picks which buttons show.
 */
export function SidebarNavIconRow({
  onBeforeNavigate,
  trailing,
}: SidebarNavRowProps & { trailing: ReactNode }) {
  const { items, setVisible } = useSidebarNavItems("header");
  const visibleItems = useMemo(() => items.filter((item) => item.visible), [items]);
  const groupRef = useRef<View | null>(null);
  const iconRow = useMemo(() => ({ items, setVisible }), [items, setVisible]);

  return (
    <SidebarNavIconRowContext.Provider value={iconRow}>
      <View style={styles.iconRow} testID="sidebar-nav-icon-row">
        <View ref={groupRef} collapsable={false} style={styles.iconRowButtons}>
          {visibleItems.map((item) => renderNavItem(item, groupRef, onBeforeNavigate))}
        </View>
        {trailing}
      </View>
    </SidebarNavIconRowContext.Provider>
  );
}

const SidebarNewWorkspaceRow = memo(function SidebarNewWorkspaceRow({
  onBeforeNavigate,
}: SidebarNavRowProps) {
  const { t } = useTranslation();
  const shortcutKeys = useShortcutKeys(builtinSidebarNavShortcutAction("new-workspace"));
  const activeWorkspaceSelection = useActiveWorkspaceSelection();
  const activeWorkspaceServerId = activeWorkspaceSelection?.serverId ?? null;
  const activeWorkspaceId = activeWorkspaceSelection?.workspaceId ?? null;
  const activeWorkspace = useWorkspace(activeWorkspaceServerId, activeWorkspaceId);
  const supportsWorkspaceMultiplicity = useHostFeature(
    activeWorkspaceServerId,
    "workspaceMultiplicity",
  );
  const canUseActiveWorkspaceContext = Boolean(
    activeWorkspace &&
    (supportsWorkspaceMultiplicity || canCreateWorktreeForProjectKind(activeWorkspace.projectKind)),
  );

  const handlePress = useCallback(() => {
    onBeforeNavigate?.();
    router.push(
      activeWorkspaceServerId
        ? buildNewWorkspaceRoute(
            activeWorkspace && canUseActiveWorkspaceContext
              ? {
                  serverId: activeWorkspaceServerId,
                  sourceDirectory: activeWorkspace.projectRootPath,
                  projectId: activeWorkspace.projectId,
                }
              : { serverId: activeWorkspaceServerId },
          )
        : buildNewWorkspaceRoute(),
    );
  }, [activeWorkspace, activeWorkspaceServerId, canUseActiveWorkspaceContext, onBeforeNavigate]);

  return (
    <SidebarHeaderRow
      icon={Plus}
      label={t(builtinSidebarNavLabelKey("new-workspace"))}
      onPress={handlePress}
      testID="sidebar-global-new-workspace"
      variant="compact"
      shortcutKeys={shortcutKeys}
    />
  );
});

function SidebarHistoryRow({ onBeforeNavigate }: SidebarNavRowProps) {
  const { t } = useTranslation();
  const pathname = usePathname();
  const handlePress = useCallback(() => {
    onBeforeNavigate?.();
    router.push(buildSessionsRoute());
  }, [onBeforeNavigate]);

  return (
    <SidebarHeaderRow
      icon={History}
      label={t(builtinSidebarNavLabelKey("history"))}
      onPress={handlePress}
      isActive={pathname.includes("/sessions")}
      testID="sidebar-sessions"
      variant="compact"
    />
  );
}

function SidebarSearchRow() {
  const { t } = useTranslation();
  const shortcutKeys = useShortcutKeys(builtinSidebarNavShortcutAction("search"));
  const setCommandCenterOpen = useKeyboardShortcutsStore((state) => state.setCommandCenterOpen);
  const handlePress = useCallback(() => {
    setCommandCenterOpen(true);
  }, [setCommandCenterOpen]);

  return (
    <SidebarHeaderRow
      icon={Search}
      label={t(builtinSidebarNavLabelKey("search"))}
      onPress={handlePress}
      testID="sidebar-search"
      variant="compact"
      shortcutKeys={shortcutKeys}
    />
  );
}

function SidebarSchedulesRow({ onBeforeNavigate }: SidebarNavRowProps) {
  const { t } = useTranslation();
  const pathname = usePathname();
  const handlePress = useCallback(() => {
    onBeforeNavigate?.();
    router.push(buildSchedulesRoute());
  }, [onBeforeNavigate]);

  return (
    <SidebarHeaderRow
      icon={CalendarClock}
      label={t(builtinSidebarNavLabelKey("schedules"))}
      onPress={handlePress}
      isActive={pathname.includes("/schedules")}
      testID="sidebar-schedules"
      variant="compact"
    />
  );
}

function SidebarNotesRow({ onBeforeNavigate }: SidebarNavRowProps) {
  const { t } = useTranslation();
  const pathname = usePathname();
  const handlePress = useCallback(() => {
    onBeforeNavigate?.();
    router.push(buildNotesRoute());
  }, [onBeforeNavigate]);

  return (
    <SidebarHeaderRow
      icon={NotebookPen}
      label={t(builtinSidebarNavLabelKey("notes"))}
      onPress={handlePress}
      isActive={pathname === buildNotesRoute()}
      testID="sidebar-notes"
      variant="compact"
    />
  );
}

const BUILTIN_ROWS: Record<BuiltinSidebarNavId, ComponentType<SidebarNavRowProps>> = {
  "new-workspace": SidebarNewWorkspaceRow,
  history: SidebarHistoryRow,
  search: SidebarSearchRow,
  schedules: SidebarSchedulesRow,
  notes: SidebarNotesRow,
};

const styles = StyleSheet.create((theme) => ({
  iconRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: theme.spacing[2],
  },
  iconRowButtons: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
  },
}));
