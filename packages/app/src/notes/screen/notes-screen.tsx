import { useCallback, useMemo, useState, type ReactElement } from "react";
import { ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import { useIsFocused } from "expo-router/react-navigation";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  Check,
  CheckCircle2,
  Clock,
  MoreVertical,
  NotebookPen,
  Pencil,
  RotateCcw,
  Trash2,
} from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { MenuHeader } from "@/components/headers/menu-header";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  useContextMenu,
} from "@/components/ui/context-menu";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import { PressHighlight } from "@/components/ui/press-highlight";
import { isNative } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useToast } from "@/contexts/toast-context";
import { useAggregatedAgents } from "@/hooks/use-aggregated-agents";
import { useHosts } from "@/runtime/host-runtime";
import { filterNotes, type HostNote, type NoteFilter } from "@/notes/model";
import { deleteNote, editNote, useAllNotes, type NotesHostError } from "@/notes/store";
import { openNoteEditor } from "@/notes/composer-store";
import { openNote } from "@/notes/open-note";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";
import { confirmDialog } from "@/utils/confirm-dialog";
import {
  buildNoteRowModel,
  describeTimeUntil,
  reminderDay,
  type NoteRowModel,
  type NoteRowStatus,
  type NoteWaitDescription,
} from "./note-row-model";

// Themed lucide wrappers at module scope (docs/unistyles.md: no useUnistyles in render).
const ThemedKebab = withUnistyles(MoreVertical);
const ThemedPencil = withUnistyles(Pencil);
const ThemedCheck = withUnistyles(Check);
const ThemedReopen = withUnistyles(RotateCcw);
const ThemedTrash = withUnistyles(Trash2);
const ThemedClock = withUnistyles(Clock);
const ThemedDone = withUnistyles(CheckCircle2);
const ThemedEmpty = withUnistyles(NotebookPen);

const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundColor = (theme: Theme) => ({ color: theme.colors.foreground });
const destructiveColor = (theme: Theme) => ({ color: theme.colors.destructive });
const warningColor = (theme: Theme) => ({ color: theme.colors.statusWarning });
const successColor = (theme: Theme) => ({ color: theme.colors.statusSuccess });

const MENU_ICON_SIZE = 14;
const BADGE_ICON_SIZE = 12;
const EMPTY_ICON_SIZE = 24;

const FILTERS: readonly NoteFilter[] = ["all", "waiting", "open", "resolved"];

const COMMAND_KEY_SUFFIX = { any: "Any", success: "Success", failure: "Failure" } as const;
const TIME_DAY_KEY = {
  today: "notes.screen.wait.timeToday",
  tomorrow: "notes.screen.wait.timeTomorrow",
  other: "notes.screen.wait.timeOther",
} as const;
const TIME_UNTIL_KEY = {
  minute: "notes.screen.wait.inMinutes",
  hour: "notes.screen.wait.inHours",
  day: "notes.screen.wait.inDays",
} as const;

// Module-scope icon elements so menu items and badges get stable props (jsx-no-jsx-as-prop).
const editLeading = <ThemedPencil size={MENU_ICON_SIZE} uniProps={mutedColor} />;
const resolveLeading = <ThemedCheck size={MENU_ICON_SIZE} uniProps={mutedColor} />;
const reopenLeading = <ThemedReopen size={MENU_ICON_SIZE} uniProps={mutedColor} />;
const deleteLeading = <ThemedTrash size={MENU_ICON_SIZE} uniProps={destructiveColor} />;
const waitingBadgeLeading = <ThemedClock size={BADGE_ICON_SIZE} uniProps={warningColor} />;
const firedBadgeLeading = <ThemedDone size={BADGE_ICON_SIZE} uniProps={successColor} />;
const resolvedBadgeLeading = <ThemedCheck size={BADGE_ICON_SIZE} uniProps={mutedColor} />;

type PendingAction = "toggle" | "delete" | null;

export function NotesScreen(): ReactElement {
  const isFocused = useIsFocused();
  if (!isFocused) {
    return <View style={styles.container} />;
  }
  return <NotesScreenContent />;
}

function NotesScreenContent(): ReactElement {
  const { t } = useTranslation();
  const { notes, hostErrors, unsupportedHosts, loading } = useAllNotes();
  const { agents } = useAggregatedAgents({ includeArchived: true });
  const hosts = useHosts();
  const [filter, setFilter] = useState<NoteFilter>("all");

  const agentTitles = useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of agents) {
      if (agent.title) map.set(`${agent.serverId}:${agent.id}`, agent.title);
    }
    return map;
  }, [agents]);

  const rows = useMemo(() => {
    const singleHost = hosts.length <= 1;
    const agentTitle = (serverId: string, agentId: string) =>
      agentTitles.get(`${serverId}:${agentId}`) ?? null;
    return filterNotes(notes, filter).map((note) => ({
      note,
      model: buildNoteRowModel({ note, agentTitle, singleHost }),
    }));
  }, [notes, filter, hosts.length, agentTitles]);

  const filterOptions = useMemo(
    () =>
      FILTERS.map((value) => ({
        value,
        label: t(`notes.screen.filters.${value}`),
        testID: `notes-filter-${value}`,
      })),
    [t],
  );

  let content: ReactElement;
  if (loading && notes.length === 0) {
    content = (
      <View style={styles.centered}>
        <LoadingSpinner size="large" color={styles.spinner.color} />
      </View>
    );
  } else if (rows.length === 0) {
    content = <NotesEmptyState filter={filter} />;
  } else {
    content = (
      <View style={styles.listContent}>
        <View style={settingsStyles.card} testID="notes-list">
          {rows.map(({ note, model }, index) => (
            <NoteRow key={model.key} note={note} model={model} isFirst={index === 0} />
          ))}
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <MenuHeader title={t("notes.screen.title")} />
      <View style={styles.filterRow}>
        <SegmentedControl
          size="sm"
          value={filter}
          onValueChange={setFilter}
          options={filterOptions}
          testID="notes-filter"
        />
      </View>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        testID="notes-scroll"
      >
        {hostErrors.length > 0 ? <NotesHostErrorsBanner errors={hostErrors} /> : null}
        {unsupportedHosts.length > 0 ? (
          <Text style={styles.quietLine} testID="notes-unsupported-hosts">
            {t("notes.screen.unsupportedHosts", {
              count: unsupportedHosts.length,
              hosts: unsupportedHosts.map((host) => host.serverName).join(", "),
            })}
          </Text>
        ) : null}
        {content}
      </ScrollView>
    </View>
  );
}

function NotesEmptyState({ filter }: { filter: NoteFilter }): ReactElement {
  const { t } = useTranslation();
  return (
    <View style={styles.centered} testID="notes-empty">
      <ThemedEmpty size={EMPTY_ICON_SIZE} uniProps={mutedColor} />
      <Text style={styles.emptyTitle}>{t(`notes.screen.empty.${filter}`)}</Text>
      {filter === "all" ? (
        <Text style={styles.emptyDescription}>{t("notes.screen.empty.allHint")}</Text>
      ) : null}
    </View>
  );
}

function NotesHostErrorsBanner({ errors }: { errors: NotesHostError[] }): ReactElement {
  const { t } = useTranslation();
  return (
    <View style={styles.listContent}>
      <View style={styles.errorsBanner} testID="notes-host-errors">
        {errors.map((error) => (
          <Text key={error.serverId} style={styles.errorsBannerText}>
            {t("notes.screen.loadError", { host: error.serverName })}
          </Text>
        ))}
      </View>
    </View>
  );
}

function formatTime(at: Date): string {
  return at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function describeWaitText(wait: NoteWaitDescription, t: TFunction, now: Date): string {
  switch (wait.kind) {
    case "agent":
      return wait.agentName
        ? t("notes.screen.wait.agent", { agent: wait.agentName })
        : t("notes.screen.wait.agentUnnamed");
    case "command": {
      const suffix = COMMAND_KEY_SUFFIX[wait.condition];
      return wait.command
        ? t(`notes.screen.wait.namedCommand${suffix}`, { command: wait.command })
        : t(`notes.screen.wait.command${suffix}`);
    }
    case "time": {
      const time = formatTime(wait.at);
      const date = wait.at.toLocaleDateString([], { month: "short", day: "numeric" });
      const base = t(TIME_DAY_KEY[reminderDay(wait.at, now)], { time, date });
      const until = describeTimeUntil(wait.at, now);
      if (!until) return base;
      return `${base} · ${t(TIME_UNTIL_KEY[until.unit], { count: until.count })}`;
    }
  }
}

function statusBadge(
  status: NoteRowStatus,
  t: TFunction,
): { label: string; variant: StatusBadgeVariant; leading: ReactElement | null } | null {
  switch (status.kind) {
    case "waiting":
      return {
        label: t("notes.screen.status.waiting"),
        variant: "warning",
        leading: waitingBadgeLeading,
      };
    case "fired":
      return {
        label: t("notes.screen.status.done"),
        variant: "success",
        leading: firedBadgeLeading,
      };
    case "resolved":
      return {
        label: t("notes.screen.status.resolved"),
        variant: "muted",
        leading: resolvedBadgeLeading,
      };
    case "unmatched":
      return { label: t("notes.screen.status.unmatched"), variant: "muted", leading: null };
    case "open":
      return null;
  }
}

function sourceLine(model: NoteRowModel, t: TFunction): string {
  const name =
    model.source.name ??
    (model.source.kind === "agent"
      ? t("notes.screen.source.agent")
      : t("notes.screen.source.terminal"));
  return model.source.hostName ? `${model.source.hostName} • ${name}` : name;
}

function NoteRow({
  note,
  model,
  isFirst,
}: {
  note: HostNote;
  model: NoteRowModel;
  isFirst: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const isCompact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pending, setPending] = useState<PendingAction>(null);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);

  const handleOpen = useCallback(() => {
    if (!openNote(model.serverId, note)) {
      toast.error(t("notes.screen.openFailed"));
    }
  }, [model.serverId, note, toast, t]);

  const handleEdit = useCallback(() => {
    openNoteEditor(model.serverId, note.id);
  }, [model.serverId, note.id]);

  const handleToggleResolved = useCallback(() => {
    setPending("toggle");
    editNote(model.serverId, { noteId: note.id, resolved: !model.resolved })
      .catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setPending(null));
  }, [model.serverId, model.resolved, note.id, toast]);

  const handleDelete = useCallback(() => {
    void (async () => {
      const confirmed = await confirmDialog({
        title: t("notes.screen.deleteConfirm.title"),
        message: t("notes.screen.deleteConfirm.message"),
        confirmLabel: t("notes.screen.deleteConfirm.confirm"),
        destructive: true,
      });
      if (!confirmed) return;
      setPending("delete");
      try {
        await deleteNote(model.serverId, note.id);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
        setPending(null);
      }
    })();
  }, [model.serverId, note.id, toast, t]);

  const badge = statusBadge(model.status, t);
  const showKebab = isCompact || isNative || isHovered || menuOpen;

  const rowStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [styles.rowBody, pressed && styles.rowPressed],
    [],
  );

  return (
    <View
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      testID={`note-row-${note.id}`}
      style={[
        settingsStyles.row,
        styles.row,
        !isFirst && settingsStyles.rowBorder,
        isHovered && !isCompact && styles.rowHovered,
      ]}
    >
      <ContextMenu open={menuOpen} onOpenChange={setMenuOpen}>
        {/* The kebab is a sibling of the trigger: a button inside a button is invalid on web. */}
        <ContextMenuTrigger
          style={rowStyle}
          onPress={handleOpen}
          accessibilityRole="button"
          accessibilityLabel={model.title}
        >
          <NoteRowText model={model} />
          {badge ? (
            <StatusBadge label={badge.label} variant={badge.variant} leading={badge.leading} />
          ) : null}
        </ContextMenuTrigger>
        <NoteKebab visible={showKebab} noteId={note.id} label={t("notes.screen.actions.menu")} />
        <ContextMenuContent align="end" width={220} sheetTitle={model.title}>
          <ContextMenuItem
            leading={editLeading}
            onSelect={handleEdit}
            testID={`note-menu-edit-${note.id}`}
          >
            {t("notes.screen.actions.edit")}
          </ContextMenuItem>
          <ContextMenuItem
            leading={model.resolved ? reopenLeading : resolveLeading}
            status={pending === "toggle" ? "pending" : "idle"}
            pendingLabel={
              model.resolved
                ? t("notes.screen.actions.reopening")
                : t("notes.screen.actions.resolving")
            }
            onSelect={handleToggleResolved}
            testID={`note-menu-resolve-${note.id}`}
          >
            {model.resolved ? t("notes.screen.actions.reopen") : t("notes.screen.actions.resolve")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            leading={deleteLeading}
            destructive
            status={pending === "delete" ? "pending" : "idle"}
            pendingLabel={t("notes.screen.actions.deleting")}
            onSelect={handleDelete}
            testID={`note-menu-delete-${note.id}`}
          >
            {t("notes.screen.actions.delete")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </View>
  );
}

function NoteRowText({ model }: { model: NoteRowModel }): ReactElement {
  const { t } = useTranslation();
  const waitText = model.wait ? describeWaitText(model.wait, t, new Date()) : null;
  const detail =
    model.status.kind === "fired" || model.status.kind === "unmatched" ? model.status.detail : null;
  return (
    <View style={styles.textGroup}>
      <Text
        style={[settingsStyles.rowTitle, model.resolved && styles.titleResolved]}
        numberOfLines={3}
      >
        {model.title}
      </Text>
      {model.quote ? (
        <Text style={styles.quote} numberOfLines={2}>
          {model.quote}
        </Text>
      ) : null}
      <Text style={styles.meta} numberOfLines={1}>
        {sourceLine(model, t)}
      </Text>
      {waitText ? (
        <Text style={styles.meta} numberOfLines={2}>
          {waitText}
        </Text>
      ) : null}
      {detail ? (
        <Text
          style={[styles.meta, model.status.kind === "fired" && styles.detailFired]}
          numberOfLines={2}
        >
          {detail}
        </Text>
      ) : null}
    </View>
  );
}

/** Opens the row's menu anchored on itself; hidden (but laid out) on desktop until hover. */
function NoteKebab({
  visible,
  noteId,
  label,
}: {
  visible: boolean;
  noteId: string;
  label: string;
}): ReactElement {
  const menu = useContextMenu();
  const handlePress = useCallback(() => {
    menu.setAnchorRect(null);
    menu.setOpen(true);
  }, [menu]);
  return (
    <PressHighlight
      hitSlop={8}
      onPress={handlePress}
      style={kebabStyle}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={`note-kebab-${noteId}`}
    >
      {({ hovered }: PressableStateCallbackType & { hovered?: boolean }) => (
        <View style={visible ? null : styles.kebabHidden}>
          <ThemedKebab size={MENU_ICON_SIZE} uniProps={hovered ? foregroundColor : mutedColor} />
        </View>
      )}
    </PressHighlight>
  );
}

function kebabStyle({ hovered = false }: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.kebabTrigger, hovered && styles.kebabTriggerHovered];
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  filterRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingTop: theme.spacing[4],
  },
  scroll: {
    flex: 1,
    minHeight: 0,
  },
  scrollContent: {
    flexGrow: 1,
    gap: theme.spacing[3],
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[6],
  },
  listContent: {
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
  },
  centered: {
    flexGrow: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[6],
  },
  row: {
    alignItems: "flex-start",
    gap: theme.spacing[3],
  },
  rowHovered: {
    backgroundColor: theme.colors.surface2,
  },
  rowBody: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[3],
  },
  rowPressed: {
    opacity: 0.7,
  },
  textGroup: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  titleResolved: {
    color: theme.colors.foregroundMuted,
  },
  quote: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    borderLeftWidth: 2,
    borderLeftColor: theme.colors.border,
    paddingLeft: theme.spacing[2],
  },
  meta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  detailFired: {
    color: theme.colors.statusSuccess,
  },
  kebabTrigger: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.base,
  },
  kebabTriggerHovered: {
    backgroundColor: theme.colors.surface2,
  },
  kebabHidden: {
    opacity: 0,
  },
  quietLine: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
  },
  errorsBanner: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    gap: theme.spacing[1],
  },
  errorsBannerText: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
  },
  emptyTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  emptyDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  // Static color holder read by the spinner (no useUnistyles).
  spinner: {
    color: theme.colors.foregroundMuted,
  },
}));
