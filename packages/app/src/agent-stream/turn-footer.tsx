import type { AgentMetric } from "@getpaseo/protocol/agent-types";
import React, { memo, useCallback, useMemo, type ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Hourglass } from "lucide-react-native";
import { SPACING, type Theme } from "@/styles/theme";
import type { TurnTiming } from "@/timeline/turn-time";
import { getAssistantReply, getStreamItemMessageId, type StreamItem } from "@/types/stream";
import { ChatNoteRowProvider } from "@/chat-notes/context";
import {
  collectAssistantResponseContentForStreamRenderStrategy,
  type StreamStrategy,
} from "./strategy";
import { resolveAssistantTurnForkBoundary, type AssistantTurnForkBoundary } from "./turn-boundary";
import {
  AssistantTurnFooter,
  LiveElapsed,
  STREAM_METADATA_FONT_SIZE,
  type AssistantForkTarget,
} from "@/components/message";
import type { TurnFooterHost } from "./layout";
import { AssistantForkMenu } from "@/components/assistant-fork-menu";
import { SyncedLoader } from "@/components/synced-loader";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { formatWaitingLabel, WAITING_SHORT_TITLE_CHARS } from "@/background-work/presentation";
import { getStatusDotColor } from "@/utils/status-dot-color";

const ThemedSyncedLoader = withUnistyles(SyncedLoader);
const workingIndicatorColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const ThemedHourglass = withUnistyles(Hourglass);
const waitingIndicatorColorMapping = (theme: Theme) => ({
  color: getStatusDotColor({ theme, bucket: "running" }) ?? undefined,
});
export const TURN_FOOTER_BOTTOM_SPACING = SPACING[8];
// Every footer variant (running, completed with Copy, completed with only its duration) gets
// this content height, so a turn ending swaps the footer's controls without moving the rows
// above it.
const TURN_FOOTER_CONTENT_HEIGHT = 24;

export type TurnContentStrategy = StreamStrategy;
export type AssistantTurnForkHandler = (input: {
  target: AssistantForkTarget;
  boundary: AssistantTurnForkBoundary;
}) => Promise<void> | void;
/**
 * Fork handler for the turn that is still streaming. It deliberately takes no
 * boundary: `selectForkContextRows` projects the entire timeline when neither
 * boundary field is given, which is what captures the partially streamed text
 * the user is watching. Pinning a boundary here would silently drop the live
 * response — the opposite of what a fork button next to the loader promises.
 *
 * Kept separate from `AssistantTurnForkHandler` (whose `boundary` stays
 * required) so the compiler keeps enforcing that completed turns always pin one.
 */
export type InFlightTurnForkHandler = (target: AssistantForkTarget) => Promise<void> | void;

export const TurnFooter = memo(function TurnFooter({
  isRunning,
  inFlightTurnStartedAt,
  waitingOn = null,
  host,
  strategy,
  supportsTimelineCursor,
  onForkAssistantTurn,
  onForkInFlightTurn,
}: {
  isRunning: boolean;
  inFlightTurnStartedAt: Date | null;
  /** The background job the open turn is blocked on ("" when unnamed). */
  waitingOn?: string | null;
  host: TurnFooterHost | null;
  strategy: TurnContentStrategy;
  supportsTimelineCursor: boolean;
  onForkAssistantTurn?: AssistantTurnForkHandler;
  onForkInFlightTurn?: InFlightTurnForkHandler;
}) {
  if (isRunning) {
    return (
      <TurnFooterRow>
        <RunningTurnFooter
          inFlightTurnStartedAt={inFlightTurnStartedAt}
          waitingOn={waitingOn}
          onForkInFlightTurn={onForkInFlightTurn}
        />
      </TurnFooterRow>
    );
  }
  if (!host) {
    return null;
  }
  return (
    <CompletedTurnFooterRow
      strategy={strategy}
      items={host.items}
      timing={host.timing}
      startIndex={host.startIndex}
      turnMetrics={host.turnMetrics}
      supportsTimelineCursor={supportsTimelineCursor}
      onForkAssistantTurn={onForkAssistantTurn}
    />
  );
});

export const CompletedTurnFooterRow = memo(function CompletedTurnFooterRow({
  strategy,
  items,
  timing,
  startIndex,
  turnMetrics,
  supportsTimelineCursor,
  onForkAssistantTurn,
}: {
  strategy: TurnContentStrategy;
  items: StreamItem[];
  timing?: TurnTiming;
  startIndex: number;
  turnMetrics?: AgentMetric[];
  supportsTimelineCursor: boolean;
  onForkAssistantTurn?: AssistantTurnForkHandler;
}) {
  return (
    <TurnFooterRow>
      <CompletedTurnFooter
        strategy={strategy}
        items={items}
        timing={timing}
        startIndex={startIndex}
        turnMetrics={turnMetrics}
        supportsTimelineCursor={supportsTimelineCursor}
        onForkAssistantTurn={onForkAssistantTurn}
      />
    </TurnFooterRow>
  );
});

const WorkingIndicator = memo(function WorkingIndicator({
  inFlightTurnStartedAt = null,
  waitingOn = null,
  onForkInFlightTurn,
}: {
  inFlightTurnStartedAt?: Date | null;
  waitingOn?: string | null;
  onForkInFlightTurn?: InFlightTurnForkHandler;
}) {
  const active = useRetainedPanelActive();
  return (
    <View style={stylesheet.turnFooterContent}>
      {/* A turn blocked on a job is waiting, not working: an hourglass and the job's name. */}
      {waitingOn === null ? (
        <View style={stylesheet.workingLoader}>
          <ThemedSyncedLoader size={14} uniProps={workingIndicatorColorMapping} />
        </View>
      ) : (
        <View style={stylesheet.waiting} testID="turn-waiting-indicator">
          <ThemedHourglass size={14} uniProps={waitingIndicatorColorMapping} />
          <Text style={stylesheet.waitingLabel} numberOfLines={1}>
            {formatWaitingLabel(waitingOn, WAITING_SHORT_TITLE_CHARS)}
          </Text>
        </View>
      )}
      {/* Match the completed-turn footer: actions precede timing metadata. */}
      {onForkInFlightTurn ? <AssistantForkMenu onFork={onForkInFlightTurn} /> : null}
      {inFlightTurnStartedAt ? (
        <LiveElapsed
          startedAt={inFlightTurnStartedAt}
          active={active}
          style={stylesheet.workingElapsed}
          testID="turn-working-elapsed"
        />
      ) : null}
    </View>
  );
});

function RunningTurnFooter({
  inFlightTurnStartedAt,
  waitingOn,
  onForkInFlightTurn,
}: {
  inFlightTurnStartedAt: Date | null;
  waitingOn: string | null;
  onForkInFlightTurn?: InFlightTurnForkHandler;
}) {
  return (
    <View style={stylesheet.turnFooterSlot} testID="turn-working-indicator">
      <WorkingIndicator
        inFlightTurnStartedAt={inFlightTurnStartedAt}
        waitingOn={waitingOn}
        onForkInFlightTurn={onForkInFlightTurn}
      />
    </View>
  );
}

function CompletedTurnFooter({
  strategy,
  items,
  timing,
  startIndex,
  turnMetrics,
  supportsTimelineCursor,
  onForkAssistantTurn,
}: {
  strategy: TurnContentStrategy;
  items: StreamItem[];
  timing?: TurnTiming;
  startIndex: number;
  turnMetrics?: AgentMetric[];
  supportsTimelineCursor: boolean;
  onForkAssistantTurn?: AssistantTurnForkHandler;
}) {
  const getContent = useCallback(
    () =>
      collectAssistantResponseContentForStreamRenderStrategy({
        strategy,
        items,
        startIndex,
      }),
    [strategy, items, startIndex],
  );
  const boundary = resolveAssistantTurnForkBoundary({
    items,
    startIndex,
    supportsTimelineCursor,
  });
  const handleFork = useCallback(
    (target: AssistantForkTarget) => {
      if (!boundary) {
        return;
      }
      return onForkAssistantTurn?.({ target, boundary });
    },
    [boundary, onForkAssistantTurn],
  );
  const assistantItem = getAssistantReply(items[startIndex]);
  const footer = (
    <AssistantTurnFooter
      getContent={assistantItem ? getContent : undefined}
      completedAt={timing?.completedAt}
      durationMs={timing?.durationMs}
      onFork={boundary && onForkAssistantTurn ? handleFork : undefined}
      metrics={turnMetrics}
    />
  );
  return (
    <View style={stylesheet.turnFooterSlot}>
      {assistantItem ? (
        <ChatNoteRowProvider
          rowId={assistantItem.id}
          messageId={getStreamItemMessageId(assistantItem)}
          role="assistant"
        >
          {footer}
        </ChatNoteRowProvider>
      ) : (
        footer
      )}
    </View>
  );
}

function TurnFooterRow({ children }: { children: ReactNode }) {
  const rowStyle = useMemo(() => [stylesheet.streamItemWrapper, stylesheet.turnFooterRow], []);
  return (
    <View style={rowStyle} testID="turn-footer">
      {children}
    </View>
  );
}

const stylesheet = StyleSheet.create((theme) => ({
  streamItemWrapper: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
    alignSelf: "center",
    paddingHorizontal: theme.spacing[2],
  },
  // The message above drops its bottom padding for the footer (compactBottom), so this margin
  // alone sets the gap. 20 puts the footer as far below the text as the text sits below a
  // tool row: 12 message padding + 4 stream gap + 5 badge padding/border, less the footer's
  // 1px taller row.
  turnFooterRow: {
    marginTop: theme.spacing[4] + theme.spacing[1],
  },
  turnFooterSlot: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "stretch",
    minHeight: TURN_FOOTER_CONTENT_HEIGHT + TURN_FOOTER_BOTTOM_SPACING,
    paddingBottom: TURN_FOOTER_BOTTOM_SPACING,
  },
  turnFooterContent: {
    height: TURN_FOOTER_CONTENT_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-start",
    gap: theme.spacing[3],
  },
  workingElapsed: {
    color: theme.colors.foregroundMuted,
    fontSize: STREAM_METADATA_FONT_SIZE,
    fontVariant: ["tabular-nums"],
  },
  workingLoader: {
    marginLeft: -2,
  },
  waiting: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    flexShrink: 1,
    minWidth: 0,
  },
  waitingLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: STREAM_METADATA_FONT_SIZE,
    flexShrink: 1,
  },
}));
