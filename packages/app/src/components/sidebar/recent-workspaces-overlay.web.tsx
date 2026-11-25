import { memo, useMemo } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useSidebarModel } from "@/components/sidebar/sidebar-model";
import { getOverlayRoot } from "@/lib/overlay-root";
import {
  type RecentWorkspaceWalk,
  useRecentWorkspacesStore,
} from "@/stores/recent-workspaces-store";

const VISIBLE_ROWS = 8;

interface RecentWorkspaceRow {
  key: string;
  projectName: string;
  title: string;
  selected: boolean;
}

function useRecentWorkspaceRows(walk: RecentWorkspaceWalk): RecentWorkspaceRow[] {
  const { allProjects, allWorkspaceEntriesByKey } = useSidebarModel();
  return useMemo(() => {
    const placements = new Map(
      allProjects.flatMap((project) =>
        project.workspaces.map((workspace) => [workspace.workspaceKey, workspace] as const),
      ),
    );
    const start = Math.max(0, walk.index - VISIBLE_ROWS + 1);
    return walk.entries.slice(start, start + VISIBLE_ROWS).map((entry, offset) => {
      const key = `${entry.serverId}:${entry.workspaceId}`;
      const placement = placements.get(key);
      const title =
        allWorkspaceEntriesByKey.get(key)?.title ?? placement?.name ?? entry.workspaceId;
      return {
        key,
        projectName: placement?.projectName ?? "",
        title,
        selected: start + offset === walk.index,
      };
    });
  }, [allProjects, allWorkspaceEntriesByKey, walk]);
}

const RecentWorkspaceRowView = memo(function RecentWorkspaceRowView({
  row,
}: {
  row: RecentWorkspaceRow;
}) {
  return (
    <View
      testID={`recent-workspaces-row-${row.key}`}
      aria-selected={row.selected}
      style={row.selected ? styles.rowSelected : styles.row}
    >
      <Text style={styles.project} numberOfLines={1}>
        {row.projectName}
      </Text>
      <Text style={styles.separator}>›</Text>
      <Text style={styles.title} numberOfLines={1}>
        {row.title}
      </Text>
    </View>
  );
});

function RecentWorkspacesPanel({ rows }: { rows: RecentWorkspaceRow[] }) {
  const { t } = useTranslation();
  return (
    <View style={styles.backdrop}>
      <View style={styles.panel} testID="recent-workspaces-overlay">
        <Text style={styles.heading}>{t("sidebar.projectStrip.recentWorkspaces")}</Text>
        {rows.map((row) => (
          <RecentWorkspaceRowView key={row.key} row={row} />
        ))}
      </View>
    </View>
  );
}

/**
 * The list an Opt+Tab walk steps through, shown while the modifier is held. It only ever opens
 * from the keyboard and closes on release, so it takes no pointer input. Web only: a native walk
 * opens each step at once and never shows a list.
 */
export function RecentWorkspacesOverlay() {
  const walk = useRecentWorkspacesStore((state) => state.walk);
  if (!walk) return null;
  return <RecentWorkspacesPortal walk={walk} />;
}

function RecentWorkspacesPortal({ walk }: { walk: RecentWorkspaceWalk }) {
  const rows = useRecentWorkspaceRows(walk);
  return createPortal(<RecentWorkspacesPanel rows={rows} />, getOverlayRoot());
}

const styles = StyleSheet.create((theme) => ({
  backdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    paddingTop: 96,
    pointerEvents: "none",
  },
  panel: {
    width: 360,
    maxWidth: "90%",
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.popover,
    ...theme.shadow.md,
  },
  heading: {
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[1],
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    marginHorizontal: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  rowSelected: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    marginHorizontal: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
  },
  project: {
    flexShrink: 1,
    maxWidth: "45%",
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  separator: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  title: {
    flexShrink: 1,
    fontSize: theme.fontSize.base,
    color: theme.colors.popoverForeground,
  },
}));
