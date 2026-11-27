import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  saveProjectStripOrder,
  useOpenReorderProjects,
  useProjectOrderKeysStore,
} from "./project-order";
import {
  listProjectEndMoves,
  moveProjectStripEntry,
  shouldShowProjectStrip,
} from "./project-strip-model";

export interface ProjectOrderMenuAction {
  kind: "top" | "bottom" | "reorder";
  label: string;
  testID: string;
  onSelect: () => void;
}

/**
 * The order items of a project's ⋯ menu: Move to top, Move to bottom, and Reorder projects…
 * (the open rail on the desktop, the Reorder projects sheet on a phone). The list and the strip
 * share one order, so these move the project in both. With one project there is nothing to order.
 */
export function useProjectOrderMenuActions(viewKey: string): ProjectOrderMenuAction[] {
  const { t } = useTranslation();
  const projectKeys = useProjectOrderKeysStore((state) => state.keys);
  const openReorder = useOpenReorderProjects();
  return useMemo(() => {
    if (!shouldShowProjectStrip(projectKeys.length)) return [];
    const actions: ProjectOrderMenuAction[] = listProjectEndMoves({ projectKeys, viewKey }).map(
      (move) => ({
        kind: move === "top" ? "top" : "bottom",
        label: t(
          move === "top" ? "sidebar.projectStrip.moveTop" : "sidebar.projectStrip.moveBottom",
        ),
        testID: `sidebar-project-menu-move-${move}-${viewKey}`,
        onSelect: () =>
          saveProjectStripOrder(moveProjectStripEntry({ projectKeys, viewKey, move })),
      }),
    );
    actions.push({
      kind: "reorder",
      label: t("sidebar.projectStrip.reorderProjects"),
      testID: `sidebar-project-menu-reorder-${viewKey}`,
      onSelect: openReorder,
    });
    return actions;
  }, [openReorder, projectKeys, t, viewKey]);
}
