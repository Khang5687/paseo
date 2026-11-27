import { useHostFeatureMap } from "@/runtime/host-features";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceDirectoryServerIds } from "@/stores/session-store-hooks";
import { workspaceEqualityFns } from "@/stores/session-store-hooks/selectors";
import { useWorkspaceStructure } from "@/stores/session-store-hooks";
import { getHostRuntimeStore, useHostRegistryLoaded, useHosts } from "@/runtime/host-runtime";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import {
  createSidebarWorkspacePlacementSelector,
  computeSidebarOrderUpdates,
  countProjectWorkspaceStatuses,
  deriveProjectActivity,
  deriveProjectStatus,
  deriveSidebarLoadingState,
  type ProjectStatusCounts,
  type ProjectStatusSession,
  type ProjectStatusSummary,
  type SidebarProjectEntry,
  type SidebarWorkspaceEntry,
  type SidebarWorkspacePlacement,
} from "./sidebar-workspaces-view-model";
import { resolveQuietProjectKeys } from "@/components/sidebar/quiet-projects";
import { nextSnoozeWakeMs, resolveSnoozedProjectKeys } from "@/components/sidebar/project-snooze";

export {
  appendMissingOrderKeys,
  applyStoredOrdering,
  buildSidebarProjectsFromHostProjects,
  buildSidebarProjectsFromStructure,
  createSidebarWorkspaceEntry,
  buildSidebarWorkspacePlacementModel,
  computeSidebarOrderUpdates,
  deriveProjectStatus,
  deriveSidebarLoadingState,
  shouldShowSidebarHostLabels,
  type ProjectStatusCounts,
  type ProjectStatusSummary,
  type SidebarLoadingState,
  type SidebarOrderUpdates,
  type SidebarStatusWorkspacePlacement,
  type SidebarWorkspacePlacement,
  type SidebarWorkspacePlacementModel,
  type SidebarProjectEntry,
  type SidebarStateBucket,
  type SidebarWorkspaceEntry,
} from "./sidebar-workspaces-view-model";

/**
 * Aggregate status for a project's workspaces, for the collapsed project row.
 *
 * `SidebarProjectEntry` is structural — it carries workspace identity but no status — and
 * `ProjectBlock` is memoized on that stable reference, so the row can't learn about a
 * child's status without its own subscription. Compared by value, so status churn in a
 * project only re-renders the row when the aggregate actually moves.
 *
 * Pass `enabled: false` while the project is expanded: the child rows show their own dots
 * and the selector is pure cost.
 */
export function useSidebarProjectStatus(input: {
  workspaces: readonly SidebarWorkspacePlacement[];
  enabled: boolean;
}): ProjectStatusSummary | null {
  const { workspaces, enabled } = input;
  const pendingCreateAttempts = useStoreWithEqualityFn(
    useCreateFlowStore,
    (state) => state.pendingByDraftId,
    workspaceEqualityFns.deep,
  );

  const selector = useCallback(
    (state: { sessions: Record<string, ProjectStatusSession | undefined> }) => {
      if (!enabled) return null;
      return deriveProjectStatus({
        workspaces,
        sessions: state.sessions,
        pendingCreateAttempts,
      });
    },
    [enabled, pendingCreateAttempts, workspaces],
  );

  return useStoreWithEqualityFn(useSessionStore, selector, sameProjectStatus);
}

function sameProjectStatus(a: ProjectStatusSummary | null, b: ProjectStatusSummary | null) {
  if (a === null || b === null) return a === b;
  return a.bucket === b.bucket && a.waiting === b.waiting;
}

/**
 * How many of a project's workspaces sit in each dotted status, for the project strip's dots.
 * Same subscription shape as `useSidebarProjectStatus`: compared by value, so the strip entry
 * re-renders only when a count moves.
 */
export function useSidebarProjectStatusCounts(
  workspaces: readonly SidebarWorkspacePlacement[],
): ProjectStatusCounts {
  const pendingCreateAttempts = useStoreWithEqualityFn(
    useCreateFlowStore,
    (state) => state.pendingByDraftId,
    workspaceEqualityFns.deep,
  );

  const selector = useCallback(
    (state: { sessions: Record<string, ProjectStatusSession | undefined> }) =>
      countProjectWorkspaceStatuses({
        workspaces,
        sessions: state.sessions,
        pendingCreateAttempts,
      }),
    [pendingCreateAttempts, workspaces],
  );

  return useStoreWithEqualityFn(useSessionStore, selector, sameStatusCounts);
}

function sameStatusCounts(a: ProjectStatusCounts, b: ProjectStatusCounts) {
  return (
    a.needsInput === b.needsInput &&
    a.failed === b.failed &&
    a.attention === b.attention &&
    a.running === b.running
  );
}

const QUIET_CLOCK_TICK_MS = 60 * 60 * 1000;

/**
 * Wall-clock time refreshed hourly: quietness is counted in days, so an hour is fine-grained.
 * The soonest snoozed project's return adds one exact refresh, so it comes back on time.
 */
function useSidebarNow(projects: readonly SidebarProjectEntry[]): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), QUIET_CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  const wakeAt = nextSnoozeWakeMs(projects, now);
  useEffect(() => {
    if (wakeAt === null) return;
    // A snooze further out than the hourly tick waits for the tick to bring it nearer.
    const delay = Math.min(Math.max(wakeAt - Date.now(), 0) + 1000, QUIET_CLOCK_TICK_MS);
    const timer = setTimeout(() => setNow(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [wakeAt]);
  return now;
}

/**
 * The projects that fold into "More": snoozed ones, and those with no chat activity for 3 days,
 * nothing waiting on you, and not in `keep`. The selector returns a joined string so unrelated
 * session updates re-render nothing.
 */
export function useQuietProjectKeys(input: {
  projects: readonly SidebarProjectEntry[];
  keep: ReadonlySet<string>;
}): ReadonlySet<string> {
  const { projects, keep } = input;
  const now = useSidebarNow(projects);
  const snoozed = useMemo(() => resolveSnoozedProjectKeys(projects, now), [projects, now]);
  const pendingCreateAttempts = useStoreWithEqualityFn(
    useCreateFlowStore,
    (state) => state.pendingByDraftId,
    workspaceEqualityFns.deep,
  );
  const selector = useCallback(
    (state: { sessions: Record<string, ProjectStatusSession | undefined> }) =>
      resolveQuietProjectKeys({
        projects,
        keep,
        now,
        snoozed,
        activityOf: (project) =>
          deriveProjectActivity({
            workspaces: project.workspaces,
            sessions: state.sessions,
            pendingCreateAttempts,
          }),
      }).join("\n"),
    [keep, now, pendingCreateAttempts, projects, snoozed],
  );
  const joined = useStoreWithEqualityFn(useSessionStore, selector, Object.is);
  return useMemo(() => new Set(joined ? joined.split("\n") : []), [joined]);
}

const EMPTY_ORDER: string[] = [];
const EMPTY_PROJECTS: SidebarProjectEntry[] = [];
const EMPTY_WORKSPACES: SidebarWorkspacePlacement[] = [];
const EMPTY_PROJECT_NAMES = new Map<string, string>();

export interface SidebarWorkspacesListResult {
  workspaceSortSupported: boolean;
  workspacePlacements: SidebarWorkspacePlacement[];
  projects: SidebarProjectEntry[];
  projectNamesByViewKey: Map<string, string>;
  isLoading: boolean;
  isInitialLoad: boolean;
  isRevalidating: boolean;
  refreshAll: () => void;
}

export function useSidebarWorkspacesList(options?: {
  hostFilters?: readonly string[];
  enabled?: boolean;
}): SidebarWorkspacesListResult {
  const runtime = getHostRuntimeStore();
  const allHosts = useHosts();
  const hostRegistryLoaded = useHostRegistryLoaded();
  const allServerIds = useMemo(() => allHosts.map((h) => h.serverId), [allHosts]);

  const storeHostFilters = useSidebarViewStore((state) => state.hostFilters);
  const hostFilters = options?.hostFilters ?? storeHostFilters;
  const reconcileHostFilters = useSidebarViewStore((state) => state.reconcileHostFilters);
  const isActive = options?.enabled !== false;

  const serverIds = useMemo(() => {
    if (hostFilters.length === 0) {
      return allServerIds;
    }
    const selected = new Set(hostFilters);
    const matched = allServerIds.filter((id) => selected.has(id));
    // Registry has settled but none of the pinned hosts still exist — fall back to every
    // host rather than leaving the sidebar empty.
    if (hostRegistryLoaded && matched.length === 0) {
      return allServerIds;
    }
    return matched;
  }, [allServerIds, hostFilters, hostRegistryLoaded]);
  useEffect(() => {
    if (!isActive) return;
    const releases = serverIds.map((serverId) => runtime.acquireDirectoryDemand(serverId));
    return () => releases.forEach((release) => release());
  }, [isActive, runtime, serverIds]);

  useEffect(() => {
    if (!hostRegistryLoaded) {
      return;
    }
    reconcileHostFilters(allServerIds);
  }, [allServerIds, hostRegistryLoaded, reconcileHostFilters]);

  const persistedProjectOrder = useSidebarOrderStore((state) => state.projectOrder ?? EMPTY_ORDER);

  const directoryServerIds = useWorkspaceDirectoryServerIds(serverIds);

  const workspaceSort = useSidebarViewStore((state) => state.workspaceSort);
  const groupMode = useSidebarViewStore((state) => state.groupMode);
  const sortSupport = useHostFeatureMap(directoryServerIds, "workspaceSortTimes");
  const workspaceSortSupported = [...sortSupport.values()].every(Boolean);
  const sort =
    groupMode === "project" && (workspaceSort === "manual" || workspaceSortSupported)
      ? workspaceSort
      : undefined;
  const { projects: hostProjects } = useWorkspaceStructure(directoryServerIds, sort);

  const selectPlacements = useMemo(createSidebarWorkspacePlacementSelector, []);
  const sidebarModel = useMemo(
    () => selectPlacements(hostProjects),
    [hostProjects, selectPlacements],
  );

  const projects = sidebarModel.projects.length > 0 ? sidebarModel.projects : EMPTY_PROJECTS;
  const workspacePlacements =
    sidebarModel.workspaces.length > 0 ? sidebarModel.workspaces : EMPTY_WORKSPACES;
  const projectNamesByViewKey =
    sidebarModel.projectNamesByViewKey.size > 0
      ? sidebarModel.projectNamesByViewKey
      : EMPTY_PROJECT_NAMES;

  useEffect(() => {
    const orderStore = useSidebarOrderStore.getState();
    const updates = computeSidebarOrderUpdates({
      projects,
      persistedProjectOrder,
      getWorkspaceOrder: sort === "manual" ? orderStore.getWorkspaceOrder : undefined,
    });

    if (updates.projectOrder) {
      orderStore.setProjectOrder(updates.projectOrder);
    }
    for (const update of updates.workspaceOrders) {
      orderStore.setWorkspaceOrder(update.projectViewKey, update.order);
    }
  }, [persistedProjectOrder, projects, sort]);

  const refreshAll = useCallback(() => {
    if (!isActive) return;
    for (const serverId of serverIds) {
      void runtime.refreshDirectories(serverId).catch((error) => {
        console.error("[WorkspaceFetch][sidebar-refresh] failed", {
          serverId,
          error,
        });
      });
    }
  }, [isActive, runtime, serverIds]);

  const loadingState = deriveSidebarLoadingState({
    isActive,
    serverIds,
    hydratedServerIds: directoryServerIds,
    hasProjects: projects.length > 0,
  });

  return {
    workspaceSortSupported,
    workspacePlacements,
    projects,
    projectNamesByViewKey,
    ...loadingState,
    refreshAll,
  };
}
