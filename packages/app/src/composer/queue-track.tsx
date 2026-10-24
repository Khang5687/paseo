import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpToLine,
  GripVertical,
  ListX,
  MoreVertical,
  Pause,
  Pencil,
  Play,
  Trash2,
} from "lucide-react-native";
import { DraggableList, type DraggableRenderItemInfo } from "@/components/draggable-list";
import type { DraggableListDragHandleProps } from "@/components/draggable-list.types";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { MenuTriggerState } from "@/components/ui/menu";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { PressHighlight } from "@/components/ui/press-highlight";
import { isWeb } from "@/constants/platform";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { confirmDialog } from "@/utils/confirm-dialog";
import type { QueuedComposerMessage } from "./actions";
import { findQueueMove, type QueueMove } from "./daemon-queue";

export type QueuedMessage = Pick<QueuedComposerMessage, "id" | "text">;

/** Rows past this count collapse to the first `COLLAPSED_ROW_COUNT`. */
const COLLAPSE_THRESHOLD = 3;
const COLLAPSED_ROW_COUNT = 2;
const NATIVE_DRAG_LONG_PRESS_MS = 200;

export interface QueueControls {
  paused: boolean;
  onMove: (move: QueueMove) => void;
  onDelete: (id: string) => void;
  onSetPaused: (paused: boolean) => void;
  onClear: () => void;
}

interface QueueTrackProps {
  queuedMessages: readonly QueuedMessage[];
  onEdit: (id: string) => void;
  onSendNow: (id: string) => void;
  /**
   * Null on hosts without `features.messageQueueControls`: rows keep only the
   * edit and send-now buttons they had before the controls existed.
   */
  controls: QueueControls | null;
}

export function QueueTrack({
  queuedMessages,
  onEdit,
  onSendNow,
  controls,
}: QueueTrackProps): ReactElement | null {
  if (queuedMessages.length === 0) return null;
  if (!controls) {
    return (
      <BasicQueueTrack queuedMessages={queuedMessages} onEdit={onEdit} onSendNow={onSendNow} />
    );
  }
  return (
    <ControlledQueueTrack
      queuedMessages={queuedMessages}
      onEdit={onEdit}
      onSendNow={onSendNow}
      controls={controls}
    />
  );
}

interface BasicQueueTrackProps {
  queuedMessages: readonly QueuedMessage[];
  onEdit: (id: string) => void;
  onSendNow: (id: string) => void;
}

function BasicQueueTrack({ queuedMessages, onEdit, onSendNow }: BasicQueueTrackProps) {
  const { t } = useTranslation();
  const editLabel = t("composer.attachments.editQueuedMessage");
  const sendNowLabel = t("composer.attachments.sendQueuedMessageNow");
  return (
    <View style={styles.queueTrack}>
      {queuedMessages.map((item) => (
        <BasicQueuedMessageRow
          key={item.id}
          item={item}
          onEdit={onEdit}
          onSendNow={onSendNow}
          editLabel={editLabel}
          sendNowLabel={sendNowLabel}
        />
      ))}
    </View>
  );
}

interface BasicQueuedMessageRowProps {
  item: QueuedMessage;
  onEdit: (id: string) => void;
  onSendNow: (id: string) => void;
  editLabel: string;
  sendNowLabel: string;
}

function BasicQueuedMessageRow({
  item,
  onEdit,
  onSendNow,
  editLabel,
  sendNowLabel,
}: BasicQueuedMessageRowProps) {
  const handleEdit = useCallback(() => {
    onEdit(item.id);
  }, [onEdit, item.id]);
  return (
    <View style={styles.queueItem}>
      <Text style={styles.queueText} numberOfLines={2} ellipsizeMode="tail">
        {item.text}
      </Text>
      <View style={styles.queueActions}>
        <ToolbarButton
          onPress={handleEdit}
          round
          style={styles.queueActionButton}
          label={editLabel}
        >
          <ThemedPencil size={ICON_SIZE.sm} uniProps={iconForegroundMapping} />
        </ToolbarButton>
        <SendNowButton messageId={item.id} onSendNow={onSendNow} label={sendNowLabel} />
      </View>
    </View>
  );
}

interface SendNowButtonProps {
  messageId: string;
  onSendNow: (id: string) => void;
  label: string;
}

function SendNowButton({ messageId, onSendNow, label }: SendNowButtonProps) {
  const handleSendNow = useCallback(() => {
    onSendNow(messageId);
  }, [onSendNow, messageId]);
  return (
    <ToolbarButton
      onPress={handleSendNow}
      round
      style={[styles.queueActionButton, styles.queueSendButton]}
      label={label}
    >
      <ThemedArrowUp size={ICON_SIZE.sm} uniProps={iconAccentForegroundMapping} />
    </ToolbarButton>
  );
}

interface ControlledQueueTrackProps {
  queuedMessages: readonly QueuedMessage[];
  onEdit: (id: string) => void;
  onSendNow: (id: string) => void;
  controls: QueueControls;
}

interface QueuedMessageRowLabels {
  actions: string;
  edit: string;
  moveToTop: string;
  moveUp: string;
  moveDown: string;
  delete: string;
  reorder: string;
  sendNow: string;
}

function ControlledQueueTrack({
  queuedMessages,
  onEdit,
  onSendNow,
  controls,
}: ControlledQueueTrackProps) {
  const { t } = useTranslation();
  const gestureHostPresented = useRetainedPanelActive();
  const [expanded, setExpanded] = useState(false);
  const { paused, onMove, onDelete, onSetPaused, onClear } = controls;
  const count = queuedMessages.length;
  const isCollapsible = count > COLLAPSE_THRESHOLD;
  const isCollapsed = isCollapsible && !expanded;
  // Collapsing keeps a prefix, so a row's index here is its index in the queue.
  const visibleMessages = useMemo(
    () => queuedMessages.slice(0, isCollapsed ? COLLAPSED_ROW_COUNT : count),
    [count, isCollapsed, queuedMessages],
  );

  const rowLabels = useMemo<QueuedMessageRowLabels>(
    () => ({
      actions: t("composer.attachments.queuedMessageActions"),
      edit: t("composer.attachments.editQueuedMessageAction"),
      moveToTop: t("composer.attachments.moveQueuedMessageToTop"),
      moveUp: t("composer.attachments.moveQueuedMessageUp"),
      moveDown: t("composer.attachments.moveQueuedMessageDown"),
      delete: t("composer.attachments.deleteQueuedMessage"),
      reorder: t("composer.attachments.reorderQueuedMessage"),
      sendNow: t("composer.attachments.sendQueuedMessageNow"),
    }),
    [t],
  );

  const handleDragEnd = useCallback(
    (reordered: QueuedMessage[]) => {
      const move = findQueueMove(visibleMessages, reordered);
      if (move) onMove(move);
    },
    [onMove, visibleMessages],
  );

  const renderItem = useCallback(
    ({ item, index, drag, isActive, dragHandleProps }: DraggableRenderItemInfo<QueuedMessage>) => (
      <ControlledQueuedMessageRow
        item={item}
        index={index}
        isLastInQueue={index === count - 1}
        isLastVisible={index === visibleMessages.length - 1}
        drag={drag}
        isActive={isActive}
        dragHandleProps={dragHandleProps}
        onEdit={onEdit}
        onSendNow={onSendNow}
        onMove={onMove}
        onDelete={onDelete}
        labels={rowLabels}
      />
    ),
    [count, onDelete, onEdit, onMove, onSendNow, rowLabels, visibleMessages.length],
  );

  const handleTogglePaused = useCallback(() => {
    onSetPaused(!paused);
  }, [onSetPaused, paused]);

  const handleClear = useCallback(() => {
    void (async () => {
      const confirmed = await confirmDialog({
        title: t("composer.attachments.clearQueueTitle"),
        message: t("composer.attachments.clearQueueMessage"),
        confirmLabel: t("composer.attachments.clearQueueConfirm"),
        cancelLabel: t("common.actions.cancel"),
        destructive: true,
      });
      if (confirmed) onClear();
    })();
  }, [onClear, t]);

  const handleToggleExpanded = useCallback(() => {
    setExpanded((value) => !value);
  }, []);

  const headerLabel = paused
    ? t("composer.attachments.queuePausedHeader", { count })
    : t("composer.attachments.queueHeader", { count });
  const pauseToggleLabel = paused
    ? t("composer.attachments.resumeQueue")
    : t("composer.attachments.pauseQueue");
  const toggleLabel = expanded
    ? t("composer.attachments.showFewerQueuedMessages")
    : t("composer.attachments.showMoreQueuedMessages", { count: count - COLLAPSED_ROW_COUNT });

  return (
    <View style={styles.queueTrack}>
      <View style={styles.queueHeader}>
        <Text style={styles.queueHeaderLabel} numberOfLines={1}>
          {headerLabel}
        </Text>
        <View style={styles.queueHeaderActions}>
          <ToolbarButton
            onPress={handleTogglePaused}
            label={pauseToggleLabel}
            testID="composer-queue-pause-toggle"
          >
            {paused ? playIcon : pauseIcon}
          </ToolbarButton>
          <ToolbarButton
            onPress={handleClear}
            label={t("composer.attachments.clearQueue")}
            testID="composer-queue-clear"
          >
            {clearIcon}
          </ToolbarButton>
        </View>
      </View>
      <DraggableList
        testID="composer-queue-list"
        data={visibleMessages}
        keyExtractor={queuedMessageKey}
        renderItem={renderItem}
        onDragEnd={handleDragEnd}
        scrollEnabled={false}
        useDragHandle
        style={styles.queueList}
        extraData={count}
        gestureHostPresented={gestureHostPresented}
      />
      {isCollapsible ? (
        <Button
          variant="ghost"
          size="xs"
          onPress={handleToggleExpanded}
          style={styles.queueToggle}
          testID="composer-queue-collapse-toggle"
        >
          {toggleLabel}
        </Button>
      ) : null}
    </View>
  );
}

interface ControlledQueuedMessageRowProps {
  item: QueuedMessage;
  index: number;
  isLastInQueue: boolean;
  isLastVisible: boolean;
  drag: () => void;
  isActive: boolean;
  dragHandleProps?: DraggableListDragHandleProps;
  onEdit: (id: string) => void;
  onSendNow: (id: string) => void;
  onMove: (move: QueueMove) => void;
  onDelete: (id: string) => void;
  labels: QueuedMessageRowLabels;
}

function ControlledQueuedMessageRow({
  item,
  index,
  isLastInQueue,
  isLastVisible,
  drag,
  isActive,
  dragHandleProps,
  onEdit,
  onSendNow,
  onMove,
  onDelete,
  labels,
}: ControlledQueuedMessageRowProps) {
  // Cells stay contiguous (spacing lives inside them) so native drag offsets
  // match the measured cell heights.
  return (
    <View style={isLastVisible ? undefined : styles.queueRowSpacing}>
      <View style={[styles.queueItem, isActive && styles.queueItemActive]}>
        <QueueDragHandle drag={drag} dragHandleProps={dragHandleProps} label={labels.reorder} />
        <Text style={styles.queueText} numberOfLines={2} ellipsizeMode="tail">
          {item.text}
        </Text>
        <View style={styles.queueActions}>
          <QueuedMessageMenu
            messageId={item.id}
            index={index}
            isLastInQueue={isLastInQueue}
            onEdit={onEdit}
            onMove={onMove}
            onDelete={onDelete}
            labels={labels}
          />
          <SendNowButton messageId={item.id} onSendNow={onSendNow} label={labels.sendNow} />
        </View>
      </View>
    </View>
  );
}

interface QueueDragHandleProps {
  drag: () => void;
  dragHandleProps?: DraggableListDragHandleProps;
  label: string;
}

/**
 * Web hands the drag to dnd-kit through the handle props; native starts it from
 * a long press. Taps never reorder, so the row menu is the touch path.
 */
function QueueDragHandle({ drag, dragHandleProps, label }: QueueDragHandleProps) {
  if (dragHandleProps) {
    const {
      role: _dragRole,
      tabIndex: _dragTabIndex,
      "aria-roledescription": _dragRoleDescription,
      ...dragAttributes
    } = dragHandleProps.attributes ?? {};
    return (
      <View
        {...dragAttributes}
        {...dragHandleProps.listeners}
        ref={dragHandleProps.setActivatorNodeRef}
        accessibilityLabel={label}
        style={styles.queueDragHandle}
      >
        {gripIcon}
      </View>
    );
  }
  return (
    <PressHighlight
      onLongPress={drag}
      delayLongPress={NATIVE_DRAG_LONG_PRESS_MS}
      accessibilityLabel={label}
      hitSlop={8}
      style={styles.queueDragHandle}
    >
      {gripIcon}
    </PressHighlight>
  );
}

interface QueuedMessageMenuProps {
  messageId: string;
  index: number;
  isLastInQueue: boolean;
  onEdit: (id: string) => void;
  onMove: (move: QueueMove) => void;
  onDelete: (id: string) => void;
  labels: QueuedMessageRowLabels;
}

function QueuedMessageMenu({
  messageId,
  index,
  isLastInQueue,
  onEdit,
  onMove,
  onDelete,
  labels,
}: QueuedMessageMenuProps) {
  const isFirstInQueue = index === 0;
  const handleEdit = useCallback(() => onEdit(messageId), [messageId, onEdit]);
  const handleMoveToTop = useCallback(() => onMove({ messageId, toIndex: 0 }), [messageId, onMove]);
  const handleMoveUp = useCallback(
    () => onMove({ messageId, toIndex: index - 1 }),
    [index, messageId, onMove],
  );
  const handleMoveDown = useCallback(
    () => onMove({ messageId, toIndex: index + 1 }),
    [index, messageId, onMove],
  );
  const handleDelete = useCallback(() => onDelete(messageId), [messageId, onDelete]);
  return (
    <DropdownMenu compactMode="sheet">
      <DropdownMenuTrigger
        hitSlop={4}
        style={menuTriggerStyle}
        accessibilityRole={isWeb ? undefined : "button"}
        accessibilityLabel={labels.actions}
        testID={`composer-queue-menu-${messageId}`}
      >
        {moreIcon}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={200} sheetTitle={labels.actions}>
        <DropdownMenuItem leading={editLeadingIcon} onSelect={handleEdit}>
          {labels.edit}
        </DropdownMenuItem>
        <DropdownMenuItem
          leading={moveToTopLeadingIcon}
          disabled={isFirstInQueue}
          onSelect={handleMoveToTop}
        >
          {labels.moveToTop}
        </DropdownMenuItem>
        <DropdownMenuItem
          leading={moveUpLeadingIcon}
          disabled={isFirstInQueue}
          onSelect={handleMoveUp}
        >
          {labels.moveUp}
        </DropdownMenuItem>
        <DropdownMenuItem
          leading={moveDownLeadingIcon}
          disabled={isLastInQueue}
          onSelect={handleMoveDown}
        >
          {labels.moveDown}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem leading={deleteLeadingIcon} onSelect={handleDelete}>
          {labels.delete}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function queuedMessageKey(item: QueuedMessage): string {
  return item.id;
}

function menuTriggerStyle({ hovered, pressed, open }: MenuTriggerState) {
  return [styles.queueMenuTrigger, (hovered || pressed || open) && styles.queueMenuTriggerActive];
}

const styles = StyleSheet.create((theme: Theme) => ({
  queueTrack: {
    flexDirection: "column",
    gap: theme.spacing[2],
  },
  queueHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
  },
  queueHeaderLabel: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  queueHeaderActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  queueList: {
    flexGrow: 0,
  },
  queueRowSpacing: {
    paddingBottom: theme.spacing[2],
  },
  queueItem: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    gap: theme.spacing[2],
  },
  queueItemActive: {
    backgroundColor: theme.colors.surface2,
  },
  queueDragHandle: {
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "stretch",
  },
  queueText: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  queueActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  queueActionButton: {
    width: 32,
    height: 32,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface2,
  },
  queueSendButton: {
    backgroundColor: theme.colors.accent,
  },
  queueMenuTrigger: {
    width: 32,
    height: 32,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  queueMenuTriggerActive: {
    backgroundColor: theme.colors.surface2,
  },
  queueToggle: {
    alignSelf: "flex-start",
  },
}));

const ThemedPencil = withUnistyles(Pencil);
const ThemedArrowUp = withUnistyles(ArrowUp);
const ThemedArrowDown = withUnistyles(ArrowDown);
const ThemedArrowUpToLine = withUnistyles(ArrowUpToLine);
const ThemedGripVertical = withUnistyles(GripVertical);
const ThemedListX = withUnistyles(ListX);
const ThemedMoreVertical = withUnistyles(MoreVertical);
const ThemedPause = withUnistyles(Pause);
const ThemedPlay = withUnistyles(Play);
const ThemedTrash2 = withUnistyles(Trash2);
const iconForegroundMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const iconForegroundMutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const iconAccentForegroundMapping = (theme: Theme) => ({ color: theme.colors.accentForeground });

const gripIcon = <ThemedGripVertical size={ICON_SIZE.sm} uniProps={iconForegroundMutedMapping} />;
const moreIcon = <ThemedMoreVertical size={ICON_SIZE.sm} uniProps={iconForegroundMutedMapping} />;
const pauseIcon = <ThemedPause size={ICON_SIZE.sm} uniProps={iconForegroundMutedMapping} />;
const playIcon = <ThemedPlay size={ICON_SIZE.sm} uniProps={iconForegroundMutedMapping} />;
const clearIcon = <ThemedListX size={ICON_SIZE.sm} uniProps={iconForegroundMutedMapping} />;
const editLeadingIcon = <ThemedPencil size={ICON_SIZE.sm} uniProps={iconForegroundMutedMapping} />;
const moveToTopLeadingIcon = (
  <ThemedArrowUpToLine size={ICON_SIZE.sm} uniProps={iconForegroundMutedMapping} />
);
const moveUpLeadingIcon = (
  <ThemedArrowUp size={ICON_SIZE.sm} uniProps={iconForegroundMutedMapping} />
);
const moveDownLeadingIcon = (
  <ThemedArrowDown size={ICON_SIZE.sm} uniProps={iconForegroundMutedMapping} />
);
const deleteLeadingIcon = (
  <ThemedTrash2 size={ICON_SIZE.sm} uniProps={iconForegroundMutedMapping} />
);
