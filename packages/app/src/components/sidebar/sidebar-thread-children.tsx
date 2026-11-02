import equal from "fast-deep-equal";
import { memo, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Text, type PressableStateCallbackType } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { SidebarGroupToggleRow } from "@/components/sidebar/sidebar-group-toggle-row";
import { useSidebarChildWorkspaceCount } from "@/components/sidebar/sidebar-model";
import { sidebarWorkspaceRowStyles } from "@/components/sidebar/sidebar-workspace-row-content";
import { PressHighlight } from "@/components/ui/press-highlight";
import { isWeb } from "@/constants/platform";
import { WorkspaceTabIcon } from "@/screens/workspace/workspace-tab-presentation";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import { useSessionStore } from "@/stores/session-store";
import { useProviderSubagentStore } from "@/subagents/provider-store";
import {
  createThreadProviderRowsSelector,
  toSubagentRow,
  type SubagentRow,
} from "@/subagents/select";
import { buildThreadChildRows } from "@/subagents/thread-children";
import { useSubagentRowPresentation } from "@/subagents/track";
import { density } from "@/styles/density";
import type { SidebarSurfaceBackdrop } from "@/styles/surface-backdrop";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { prepareWorkspaceTab } from "@/utils/workspace-navigation";

const EMPTY_AGENT_IDS: string[] = [];

/**
 * The subagents that live inside one thread row: a fold row ("3 subagents") and, unfolded, one row
 * per same-workspace subagent and provider subagent. Subagent workspaces nest as rows of their own
 * right after this block and fold with it, so the count covers them too.
 *
 * Everything here reads state the client already holds. Provider subagents appear once their
 * parent was listed (opening the parent) or announced one live; nothing is fetched for the sidebar.
 */
export const SidebarThreadChildren = memo(function SidebarThreadChildren({
  serverId,
  workspaceId,
  workspaceKey,
  indentLevel,
}: {
  serverId: string;
  workspaceId: string;
  workspaceKey: string;
  /** The indent step of the child rows: one past the thread row's own. */
  indentLevel: number;
}) {
  const { t } = useTranslation();
  const childWorkspaceCount = useSidebarChildWorkspaceCount(workspaceKey);
  const thread = useSessionStore((state) =>
    state.sessions[serverId]?.threadAgents.get(workspaceId),
  );
  const supported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.providerSubagents === true,
  );
  const nestingSupported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.providerSubagentNesting === true,
  );
  const agentIds = thread?.agentIds ?? EMPTY_AGENT_IDS;
  const selectProviderRows = useMemo(
    () => createThreadProviderRowsSelector({ serverId, agentIds, supported, nestingSupported }),
    [agentIds, nestingSupported, serverId, supported],
  );
  const providerRows = useStoreWithEqualityFn(useProviderSubagentStore, selectProviderRows, equal);
  const rows = useMemo(
    () =>
      buildThreadChildRows({
        children: (thread?.children ?? []).map(toSubagentRow),
        providerRows,
      }),
    [providerRows, thread],
  );
  const expanded = useSidebarCollapsedSectionsStore((state) =>
    state.expandedThreadKeys.has(workspaceKey),
  );
  const toggleThreadExpanded = useSidebarCollapsedSectionsStore(
    (state) => state.toggleThreadExpanded,
  );
  const handleToggle = useCallback(
    () => toggleThreadExpanded(workspaceKey),
    [toggleThreadExpanded, workspaceKey],
  );

  const count = rows.length + childWorkspaceCount;
  if (count === 0) {
    return null;
  }
  return (
    <>
      <SidebarGroupToggleRow
        expanded={expanded}
        onPress={handleToggle}
        label={t(count === 1 ? "subagents.pillLabelOne" : "subagents.pillLabelMany", { count })}
        indentLevel={indentLevel}
        testID={`sidebar-thread-children-toggle-${workspaceKey}`}
      />
      {expanded
        ? rows.map((row) => (
            <SidebarThreadChildRow
              key={`${row.kind}:${row.id}`}
              serverId={serverId}
              workspaceId={workspaceId}
              row={row}
              indentLevel={indentLevel}
            />
          ))
        : null}
    </>
  );
});

const SidebarThreadChildRow = memo(function SidebarThreadChildRow({
  serverId,
  workspaceId,
  row,
  indentLevel,
}: {
  serverId: string;
  workspaceId: string;
  row: SubagentRow;
  indentLevel: number;
}) {
  const { t } = useTranslation();
  const presentation = useSubagentRowPresentation(row, serverId);
  const label =
    presentation.titleState === "loading" ? t("common.states.loading") : presentation.label;
  const handlePress = useCallback(() => {
    if (row.kind === "paseo") {
      navigateToAgent(row.address);
      return;
    }
    // A provider subagent is read-only: it opens its transcript as a tab in the thread it ran in.
    prepareWorkspaceTab({
      serverId,
      workspaceId,
      target: { kind: "provider_subagent", parentAgentId: row.parentAgentId, subagentId: row.id },
    });
    navigateToWorkspace({ serverId, workspaceId });
  }, [row, serverId, workspaceId]);
  const rowStyle = useCallback(
    ({ hovered = false, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.row,
      sidebarWorkspaceRowStyles.rowNested(indentLevel),
      hovered && !pressed && styles.rowHovered,
      pressed && styles.rowPressed,
    ],
    [indentLevel],
  );

  return (
    <PressHighlight
      accessibilityRole={isWeb ? undefined : "button"}
      accessibilityLabel={label}
      onPress={handlePress}
      style={rowStyle}
      highlightStyle={styles.rowPressed}
      testID={`sidebar-thread-child-${row.kind}-${row.id}`}
    >
      {({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => (
        <>
          <WorkspaceTabIcon presentation={presentation} backdrop={rowBackdrop(hovered, pressed)} />
          <Text style={styles.label} numberOfLines={1}>
            {label}
          </Text>
        </>
      )}
    </PressHighlight>
  );
});

function rowBackdrop(hovered = false, pressed: boolean): SidebarSurfaceBackdrop {
  if (pressed) return "surface2";
  return hovered ? "surfaceSidebarHover" : "surfaceSidebar";
}

const styles = StyleSheet.create((theme) => ({
  // Kept in step with the fold row in sidebar-group-toggle-row.tsx, which takes the workspace
  // row's geometry; a child row is a shorter workspace row with an agent icon.
  row: {
    minHeight: density.rowHeight,
    marginBottom: theme.spacing[0.5],
    paddingVertical: theme.spacing[2],
    paddingRight: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    userSelect: "none",
  },
  rowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  label: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    minWidth: 0,
    flexShrink: 1,
  },
}));
