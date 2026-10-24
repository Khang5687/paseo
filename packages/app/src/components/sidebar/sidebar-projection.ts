import type { TFunction } from "i18next";
import { buildStatusGroups } from "@/hooks/sidebar-status-view-model";
import {
  splitPinnedSidebarGroups,
  type PinnedSidebarGroups,
  type PinnedSidebarKeys,
} from "@/hooks/use-sidebar-pins";
import { splitSettledSidebarGroups, type SettledSidebarKeys } from "@/hooks/use-sidebar-settled";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
import type { SidebarGroupMode } from "@/stores/sidebar-view-store";
import {
  resolveSidebarProjectIconTargets,
  type SidebarProjectIconTarget,
} from "@/utils/sidebar-project-row-model";
import {
  buildSidebarShortcutSections,
  type SidebarShortcutModel,
  type SidebarShortcutSection,
} from "@/utils/sidebar-shortcuts";
import { statusWorkspaceGroups, type SidebarWorkspaceGroup } from "./sidebar-labels";
import { createWorkspaceRowNester, inheritParentPins } from "./workspace-nesting";

export interface SidebarProjection {
  /** `unpinnedProjects` here also has the settled rows removed: it is exactly what the list shows. */
  pinnedGroups: PinnedSidebarGroups;
  workspaceGroups: SidebarWorkspaceGroup[];
  /** The flat Settled section at the bottom of the list, most recently settled first. */
  settledRows: SidebarWorkspacePlacement[];
  /**
   * The project icons this projection needs fetched, keyed by `projectViewKey` — one per project,
   * whatever the mode groups by. It sits here rather than beside `useProjectIcons` in the list
   * because it is the same `projects` the rows above are projected from: a mode that renders a
   * row can only ever ask for an icon this list already covers. It used to be derived in the
   * list, under a `groupMode === "status"` gate written when status was the only mode that put
   * icons on rows.
   */
  projectIconTargets: SidebarProjectIconTarget[];
  shortcutModel: SidebarShortcutModel;
  /** Indent level of each subagent workspace row nested under its parent; top-level rows absent. */
  nestingDepthByWorkspaceKey: ReadonlyMap<string, number>;
}

export interface SidebarProjectionInput {
  projects: SidebarProjectEntry[];
  pinnedKeys: PinnedSidebarKeys;
  settledKeys: SettledSidebarKeys;
  pinnedWorkspaceOrder: string[];
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  projectNamesByViewKey: Map<string, string>;
  groupMode: SidebarGroupMode;
  pinnedCollapsed: boolean;
  collapsedProjectKeys: ReadonlySet<string>;
  collapsedWorkspaceGroupKeys: ReadonlySet<string>;
  /** Child workspaceKey -> parent workspaceKey for subagent workspaces. */
  parentKeyByWorkspaceKey: ReadonlyMap<string, string>;
  t: TFunction;
}

export function buildSidebarProjection(input: SidebarProjectionInput): SidebarProjection {
  const visibleWorkspaceKeys = new Set(
    input.projects.flatMap((project) =>
      project.workspaces.map((workspace) => workspace.workspaceKey),
    ),
  );
  const pinnedWorkspaceKeys = inheritParentPins({
    pinnedWorkspaceKeys: input.pinnedKeys.pinnedWorkspaceKeys,
    visibleWorkspaceKeys,
    parentKeyByWorkspaceKey: input.parentKeyByWorkspaceKey,
  });
  // A child row follows a settled parent into Settled the same way it follows a pinned one.
  const settledWorkspaceKeys = inheritParentPins({
    pinnedWorkspaceKeys: input.settledKeys.settledWorkspaceKeys,
    visibleWorkspaceKeys,
    parentKeyByWorkspaceKey: input.parentKeyByWorkspaceKey,
  });
  const pinned = splitPinnedSidebarGroups({
    projects: input.projects,
    keys: { ...input.pinnedKeys, pinnedWorkspaceKeys },
    pinnedWorkspaceOrder: input.pinnedWorkspaceOrder,
  });
  // Settled splits after Pinned, from what Pinned left behind, so pinned wins.
  const settled = splitSettledSidebarGroups({
    projects: pinned.unpinnedProjects,
    keys: { ...input.settledKeys, settledWorkspaceKeys },
  });
  // Each mode nests only the lists it renders, so the depth map describes the rows on screen.
  const nester = createWorkspaceRowNester(input.parentKeyByWorkspaceKey);
  let unpinnedProjects = settled.unsettledProjects;
  if (input.groupMode === "project") {
    unpinnedProjects = unpinnedProjects.map((project) => {
      const workspaces = nester.nest(project.workspaces);
      return workspaces === project.workspaces ? project : { ...project, workspaces };
    });
  }
  const pinnedGroups: PinnedSidebarGroups = {
    pinnedChats: nester.nest(pinned.pinnedChats),
    unpinnedProjects,
  };
  const settledRows = nester.nest(settled.settledRows);
  const pinnedWorkspaceKeySet = new Set(pinnedWorkspaceKeys);
  const settledWorkspaceKeySet = new Set(settledWorkspaceKeys);
  const listedWorkspaces = Array.from(input.workspaceEntriesByKey.values()).filter(
    (workspace) =>
      !pinnedWorkspaceKeySet.has(workspace.workspaceKey) &&
      !settledWorkspaceKeySet.has(workspace.workspaceKey),
  );
  // One switch decides both what the list groups by and what the keyboard shortcuts walk, so the
  // two cannot disagree and a new grouping mode is a compile error here rather than a silent
  // fall-through to the project rows. Status groups nest only within themselves: a child that
  // needs attention stays in its own status group instead of hiding under a finished parent.
  const workspaceGroups = buildWorkspaceGroups(input, listedWorkspaces);
  // The groups were built just above, so nesting their rows in place shares nothing.
  for (const group of workspaceGroups) {
    group.rows = nester.nest(group.rows);
  }

  // Settled rows are put away, so no section here numbers them.
  const sections: SidebarShortcutSection[] = [];
  if (!input.pinnedCollapsed) {
    sections.push({ workspaces: pinnedGroups.pinnedChats });
  }
  if (input.groupMode === "project") {
    sections.push(
      ...pinnedGroups.unpinnedProjects.map((project) => ({
        workspaces: project.workspaces,
        collapsed: input.collapsedProjectKeys.has(project.viewKey),
      })),
    );
  } else {
    sections.push(
      ...workspaceGroups.map((group) => ({
        workspaces: group.rows,
        collapsed: input.collapsedWorkspaceGroupKeys.has(group.key),
      })),
    );
  }

  return {
    pinnedGroups,
    workspaceGroups,
    settledRows,
    projectIconTargets: resolveSidebarProjectIconTargets(input.projects),
    shortcutModel: buildSidebarShortcutSections({ sections }),
    nestingDepthByWorkspaceKey: nester.depthByWorkspaceKey,
  };
}

/** Project mode keeps its project headers and groups nothing; status mode groups the rows. */
function buildWorkspaceGroups(
  input: SidebarProjectionInput,
  listedWorkspaces: SidebarWorkspaceEntry[],
): SidebarWorkspaceGroup[] {
  switch (input.groupMode) {
    case "project":
      return [];
    case "status":
      return statusWorkspaceGroups(
        buildStatusGroups(listedWorkspaces, input.projectNamesByViewKey, input.t),
      );
  }
}
