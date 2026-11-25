import { useTranslation } from "react-i18next";
import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import {
  useQuietProjectKeys,
  useSidebarWorkspacesList,
  type SidebarProjectEntry,
  type SidebarWorkspaceEntry,
  type SidebarWorkspacesListResult,
} from "@/hooks/use-sidebar-workspaces-list";
import { useSidebarWorkspaceEntries } from "@/hooks/use-sidebar-workspace-entries";
import { usePinnedSidebarKeys, type PinnedSidebarGroups } from "@/hooks/use-sidebar-pins";
import { useSidebarWorkspaceParents } from "@/hooks/use-sidebar-workspace-parents";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import {
  hasActiveSidebarLabelFilter,
  useSidebarViewStore,
  type SidebarGroupMode,
} from "@/stores/sidebar-view-store";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import type { SidebarShortcutModel } from "@/utils/sidebar-shortcuts";
import { buildSidebarProjection } from "./sidebar-projection";
import type { SidebarProjectIconTarget } from "@/utils/sidebar-project-row-model";
import { filterWorkspacesByLabels, type SidebarWorkspaceGroup } from "./sidebar-labels";
import { filterWorkspacesByProjects, resolveActiveProjectFilters } from "./sidebar-project-filter";
import { sortProjectsByUrgency } from "./urgent-sort";
import { resolveQuietKeep, splitQuietProjects } from "./quiet-projects";
import { useSidebarQuietFoldStore } from "@/stores/sidebar-quiet-fold-store";
import { useLastWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import {
  hasAuthoritativeWorkspaceLabelCatalog,
  useWorkspaceLabelProjection,
} from "@/workspace-labels";

interface SidebarModel extends SidebarWorkspacesListResult {
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  /** Every hydrated row, before any filter: what "waiting on you in any project" reads. */
  allWorkspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  /**
   * Every project the sidebar could show, before any filter narrows it.
   *
   * `projects` is the FILTERED list. A surface that offers a filter picker must read this one, or
   * narrowing the filter deletes the rows that would undo it.
   */
  allProjects: SidebarProjectEntry[];
  /** The project filter as it is actually being applied — see `resolveActiveProjectFilters`. */
  resolvedProjectFilters: readonly string[];
  hasProjectsBeforeFilter: boolean;
  groupMode: SidebarGroupMode;
  workspaceGroups: SidebarWorkspaceGroup[];
  projectIconTargets: SidebarProjectIconTarget[];
  pinnedGroups: PinnedSidebarGroups;
  collapsedProjectKeys: ReadonlySet<string>;
  toggleProjectCollapsed: (projectViewKey: string) => void;
  shortcutModel: SidebarShortcutModel;
  /**
   * `allProjects` split for the rail and chip row: `quiet` holds projects folded into "More"
   * (no chat activity for 3 days, nothing waiting on you). Digit jumps count `active` first.
   */
  stripProjects: { active: SidebarProjectEntry[]; quiet: SidebarProjectEntry[] };
  /** How many projects the project list folded away. Zero while a project filter applies. */
  listQuietCount: number;
  nestingDepthByWorkspaceKey: ReadonlyMap<string, number>;
}

const SidebarModelContext = createContext<SidebarModel | null>(null);

export function SidebarModelProvider({
  active,
  keyboardNavigationActive = false,
  children,
}: {
  active?: boolean;
  keyboardNavigationActive?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const modelActive = active !== false || keyboardNavigationActive;
  const list = useSidebarWorkspacesList({ enabled: modelActive });
  const showBackground = useSidebarViewStore((state) => state.showBackground);
  const groupMode = useSidebarViewStore((state) => state.groupMode);
  const labelFilter = useSidebarViewStore((state) => state.labelFilter);
  const projectFilters = useSidebarViewStore((state) => state.projectFilters);
  const reconcileLabelFilter = useSidebarViewStore((state) => state.reconcileLabelFilter);
  const { hosts: labelHosts } = useWorkspaceLabelProjection();
  const collapsedProjectKeys = useSidebarCollapsedSectionsStore(
    (state) => state.collapsedProjectKeys,
  );
  const collapsedWorkspaceGroupKeys = useSidebarCollapsedSectionsStore(
    (state) => state.collapsedWorkspaceGroupKeys,
  );
  const pinnedCollapsed = useSidebarCollapsedSectionsStore((state) => state.collapsedPinned);
  const expandedThreadKeys = useSidebarCollapsedSectionsStore((state) => state.expandedThreadKeys);
  const pinnedWorkspaceOrder = useSidebarOrderStore((state) => state.pinnedWorkspaceOrder);
  const toggleProjectCollapsed = useSidebarCollapsedSectionsStore(
    (state) => state.toggleProjectCollapsed,
  );
  const availableLabelNames = useMemo(
    () => labelHosts.flatMap((host) => host.labels.map((label) => label.name)),
    [labelHosts],
  );
  const hasAuthoritativeLabelCatalog = hasAuthoritativeWorkspaceLabelCatalog(labelHosts);
  useEffect(() => {
    if (!hasAuthoritativeLabelCatalog) return;
    reconcileLabelFilter(availableLabelNames);
  }, [availableLabelNames, hasAuthoritativeLabelCatalog, reconcileLabelFilter]);
  const hasActiveLabelFilter = hasActiveSidebarLabelFilter(labelFilter);
  const resolvedProjectFilters = useMemo(
    () =>
      resolveActiveProjectFilters(
        projectFilters,
        new Set(list.projects.map((project) => project.viewKey)),
      ),
    [projectFilters, list.projects],
  );
  const hasActiveProjectFilter = resolvedProjectFilters.length > 0;
  // The project filter is deliberately absent from this gate. It reads `projectViewKey`, which
  // lives on the project and the placement, so it can narrow the project list without hydrating
  // anything; the label filter reads `labels`, which only exists on an entry. Hydration opens a
  // live session-store subscription over every workspace on every visible host, so widening this
  // for a filter that does not need it costs a retained-but-inactive sidebar real work.
  // Hardware keyboard navigation needs the same filtered targets while the sidebar is hidden.
  const needsWorkspaceEntries = groupMode !== "project" || hasActiveLabelFilter;
  const workspaceEntriesByKey = useSidebarWorkspaceEntries(
    list.workspacePlacements,
    modelActive || needsWorkspaceEntries,
  );
  const filteredWorkspaceEntriesByKey = useMemo(() => {
    const byProject = filterWorkspacesByProjects({
      workspaces: [...workspaceEntriesByKey.values()],
      projectFilters: resolvedProjectFilters,
    });
    const filtered = filterWorkspacesByLabels({
      workspaces: byProject.filter((workspace) => showBackground || !workspace.background),
      ...labelFilter,
    });
    return new Map(filtered.map((workspace) => [workspace.workspaceKey, workspace]));
  }, [showBackground, labelFilter, resolvedProjectFilters, workspaceEntriesByKey]);
  const visibleWorkspaceKeys = useMemo(
    () => new Set(filteredWorkspaceEntriesByKey.keys()),
    [filteredWorkspaceEntriesByKey],
  );
  // The two filters prune differently on purpose. The project filter is a membership test on the
  // project itself, so a project you filtered TO survives even with no workspaces — it still owns
  // a header row you can create your first workspace under. The label filter can only ask about
  // workspaces, so a project it empties has nothing left to show.
  const filteredProjects = useMemo(() => {
    let projects = list.projects;
    if (hasActiveProjectFilter) {
      const included = new Set(resolvedProjectFilters);
      projects = projects.filter((project) => included.has(project.viewKey));
    }
    if (hasActiveLabelFilter || !showBackground) {
      projects = projects.flatMap((project) => {
        const workspaces = project.workspaces.filter((workspace) =>
          visibleWorkspaceKeys.has(workspace.workspaceKey),
        );
        return workspaces.length > 0 || (!hasActiveLabelFilter && project.workspaces.length === 0)
          ? [workspaces.length === project.workspaces.length ? project : { ...project, workspaces }]
          : [];
      });
    }
    return projects;
  }, [
    showBackground,
    hasActiveLabelFilter,
    hasActiveProjectFilter,
    resolvedProjectFilters,
    list.projects,
    visibleWorkspaceKeys,
  ]);
  const workspaceSort = useSidebarViewStore((state) => state.workspaceSort);
  // Urgent first reorders by live status, which only the hydrated entries carry.
  const orderedProjects = useMemo(
    () =>
      workspaceSort === "urgent" && groupMode === "project"
        ? sortProjectsByUrgency(filteredProjects, filteredWorkspaceEntriesByKey)
        : filteredProjects,
    [filteredProjects, filteredWorkspaceEntriesByKey, groupMode, workspaceSort],
  );
  const pinnedKeys = usePinnedSidebarKeys(orderedProjects);
  const openWorkspace = useLastWorkspaceSelection();
  const quietKeep = useMemo(
    () =>
      resolveQuietKeep({
        projects: list.projects,
        workspaceKeys: openWorkspace
          ? [
              ...pinnedKeys.pinnedWorkspaceKeys,
              `${openWorkspace.serverId}:${openWorkspace.workspaceId}`,
            ]
          : pinnedKeys.pinnedWorkspaceKeys,
        projectKeys: resolvedProjectFilters,
      }),
    [list.projects, openWorkspace, pinnedKeys.pinnedWorkspaceKeys, resolvedProjectFilters],
  );
  const quietProjectKeys = useQuietProjectKeys({ projects: list.projects, keep: quietKeep });
  const stripProjects = useMemo(
    () => splitQuietProjects(list.projects, quietProjectKeys),
    [list.projects, quietProjectKeys],
  );
  const quietOpen = useSidebarQuietFoldStore((state) => state.open);
  // The list folds only while it shows every project: a filter is an explicit pick.
  const listFold = useMemo(() => {
    if (groupMode !== "project" || hasActiveProjectFilter) {
      return { projects: orderedProjects, quietCount: 0 };
    }
    const split = splitQuietProjects(orderedProjects, quietProjectKeys);
    if (split.quiet.length === 0) return { projects: orderedProjects, quietCount: 0 };
    return {
      projects: quietOpen ? [...split.active, ...split.quiet] : split.active,
      quietCount: split.quiet.length,
    };
  }, [groupMode, hasActiveProjectFilter, orderedProjects, quietOpen, quietProjectKeys]);
  const serverIds = useMemo(
    () => Array.from(new Set(list.workspacePlacements.map((workspace) => workspace.serverId))),
    [list.workspacePlacements],
  );
  const parentKeyByWorkspaceKey = useSidebarWorkspaceParents(serverIds);
  const projectionInput = useMemo(
    () => ({
      projects: listFold.projects,
      pinnedKeys,
      pinnedWorkspaceOrder,
      workspaceEntriesByKey: filteredWorkspaceEntriesByKey,
      projectNamesByViewKey: list.projectNamesByViewKey,
      groupMode,
      pinnedCollapsed,
      collapsedProjectKeys,
      collapsedWorkspaceGroupKeys,
      parentKeyByWorkspaceKey,
      expandedThreadKeys,
      t,
    }),
    [
      expandedThreadKeys,
      collapsedProjectKeys,
      collapsedWorkspaceGroupKeys,
      groupMode,
      list.projectNamesByViewKey,
      listFold.projects,
      pinnedCollapsed,
      pinnedKeys,
      pinnedWorkspaceOrder,
      filteredWorkspaceEntriesByKey,
      parentKeyByWorkspaceKey,
      t,
    ],
  );
  const projection = useMemo(() => buildSidebarProjection(projectionInput), [projectionInput]);
  const childWorkspaceCounts = useStableCountMap(projection.childWorkspaceCountByWorkspaceKey);
  const value = useMemo(
    () => ({
      ...list,
      projects: listFold.projects,
      allProjects: list.projects,
      resolvedProjectFilters,
      hasProjectsBeforeFilter: list.projects.length > 0,
      workspaceEntriesByKey: filteredWorkspaceEntriesByKey,
      allWorkspaceEntriesByKey: workspaceEntriesByKey,
      groupMode,
      workspaceGroups: projection.workspaceGroups,
      projectIconTargets: projection.projectIconTargets,
      pinnedGroups: projection.pinnedGroups,
      collapsedProjectKeys,
      toggleProjectCollapsed,
      shortcutModel: projection.shortcutModel,
      listQuietCount: listFold.quietCount,
      stripProjects,
      nestingDepthByWorkspaceKey: projection.nestingDepthByWorkspaceKey,
    }),
    [
      resolvedProjectFilters,
      collapsedProjectKeys,
      groupMode,
      list,
      listFold,
      projection,
      stripProjects,
      toggleProjectCollapsed,
      filteredWorkspaceEntriesByKey,
      workspaceEntriesByKey,
    ],
  );

  return (
    <SidebarModelContext.Provider value={value}>
      <SidebarChildWorkspaceCountsContext.Provider value={childWorkspaceCounts}>
        {children}
      </SidebarChildWorkspaceCountsContext.Provider>
    </SidebarModelContext.Provider>
  );
}

const EMPTY_COUNTS: ReadonlyMap<string, number> = new Map();

/**
 * Subagent workspace rows under each thread row. Its own context, kept identical across
 * projections that did not change it, so a thread's fold row re-renders only when its count moves.
 */
const SidebarChildWorkspaceCountsContext = createContext<ReadonlyMap<string, number>>(EMPTY_COUNTS);

export function useSidebarChildWorkspaceCount(workspaceKey: string): number {
  return useContext(SidebarChildWorkspaceCountsContext).get(workspaceKey) ?? 0;
}

function useStableCountMap(next: ReadonlyMap<string, number>): ReadonlyMap<string, number> {
  const previous = useRef(EMPTY_COUNTS);
  const current = previous.current;
  const same =
    current.size === next.size && [...next].every(([key, count]) => current.get(key) === count);
  if (!same) previous.current = next;
  return previous.current;
}

export function useSidebarModel(): SidebarModel {
  const model = useContext(SidebarModelContext);
  if (!model) throw new Error("SidebarModelProvider is required");
  return model;
}
