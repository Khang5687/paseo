import type {
  DaemonClient,
  FetchAgentTimelinePayload,
  ProviderSubagentTimelinePayload,
} from "@getpaseo/client/internal/daemon-client";

type AgentTimelineEntry = FetchAgentTimelinePayload["entries"][number];
type ProviderSubagentTimelineRow = ProviderSubagentTimelinePayload["rows"][number];
type TimelineWindow = FetchAgentTimelinePayload["window"];
type TimelineSeqSpan = Pick<AgentTimelineEntry, "seqStart" | "seqEnd" | "sourceSeqRanges">;

export interface SeqTimeline<Row extends TimelineSeqSpan> {
  epoch: string;
  window: TimelineWindow;
  rows: Row[];
}

export interface SeqLookup {
  seq: number;
  epoch: string | null;
  context: number;
}

export interface LocatedTimelineRow<Row> {
  isTarget: boolean;
  row: Row;
}

export type TimelineSeqLookupErrorCode =
  | "epoch_mismatch"
  | "seq_after_head"
  | "seq_before_window"
  | "seq_not_found";

export class TimelineSeqLookupError extends Error {
  readonly code: TimelineSeqLookupErrorCode;

  constructor(code: TimelineSeqLookupErrorCode, message: string) {
    super(message);
    this.name = "TimelineSeqLookupError";
    this.code = code;
  }
}

/**
 * Finds the projected row that merged canonical `seq`, plus `context` rows of
 * display-order neighbours on each side.
 */
export function locateTimelineRows<Row extends TimelineSeqSpan>(
  timeline: SeqTimeline<Row>,
  lookup: SeqLookup,
): LocatedTimelineRow<Row>[] {
  const { seq } = lookup;
  if (lookup.epoch !== null && lookup.epoch !== timeline.epoch) {
    throw new TimelineSeqLookupError(
      "epoch_mismatch",
      `Epoch mismatch: the reference is from epoch ${lookup.epoch}, but the timeline is now at epoch ${timeline.epoch}. A seq only identifies a row within its own epoch.`,
    );
  }
  const { minSeq, maxSeq } = timeline.window;
  if (seq > maxSeq) {
    throw new TimelineSeqLookupError(
      "seq_after_head",
      `seq ${seq} is past the timeline head: the latest seq in epoch ${timeline.epoch} is ${maxSeq}.`,
    );
  }
  if (seq < minSeq) {
    throw new TimelineSeqLookupError(
      "seq_before_window",
      `seq ${seq} is older than the retained timeline: the earliest seq in epoch ${timeline.epoch} is ${minSeq}.`,
    );
  }
  // seqStart..seqEnd can span rows that belong to other items (a tool call keeps its
  // display slot while its completion lands later), so only the source ranges say
  // which row a seq was merged into.
  const targetIndex = timeline.rows.findIndex((row) =>
    row.sourceSeqRanges.some((range) => range.startSeq <= seq && seq <= range.endSeq),
  );
  if (targetIndex === -1) {
    throw new TimelineSeqLookupError(
      "seq_not_found",
      `No timeline row contains seq ${seq} in epoch ${timeline.epoch}.`,
    );
  }
  const start = Math.max(0, targetIndex - lookup.context);
  const end = Math.min(timeline.rows.length, targetIndex + lookup.context + 1);
  return timeline.rows.slice(start, end).map((row, offset) => ({
    isTarget: start + offset === targetIndex,
    row,
  }));
}

export interface SeqLookupTarget {
  agentId: string;
  subagentId: string | null;
}

type SeqSpannedSubagentRow = ProviderSubagentTimelineRow & TimelineSeqSpan;

// COMPAT(projectedSubagentTimeline): added after v0.8.0, remove after 2027-03-14.
// The span fields are optional on the wire for hosts that predate projected subagent
// history; the client already refuses those hosts, so this only narrows the type.
function withSeqSpan(row: ProviderSubagentTimelineRow): SeqSpannedSubagentRow {
  const seqStart = row.seqStart ?? row.seq;
  const seqEnd = row.seqEnd ?? row.seq;
  const sourceSeqRanges = row.sourceSeqRanges ?? [{ startSeq: seqStart, endSeq: seqEnd }];
  return { ...row, seqStart, seqEnd, sourceSeqRanges };
}

async function fetchSeqTimeline(
  client: DaemonClient,
  target: SeqLookupTarget,
): Promise<SeqTimeline<AgentTimelineEntry | SeqSpannedSubagentRow>> {
  if (target.subagentId === null) {
    const timeline = await client.fetchAgentTimeline(target.agentId, {
      direction: "tail",
      limit: 0,
      projection: "projected",
    });
    return { epoch: timeline.epoch, window: timeline.window, rows: timeline.entries };
  }
  const timeline = await client.fetchProviderSubagentTimeline(target.agentId, target.subagentId, {
    direction: "tail",
    limit: 0,
  });
  return { epoch: timeline.epoch, window: timeline.window, rows: timeline.rows.map(withSeqSpan) };
}

/**
 * Fetches the whole projected timeline in display order, because context rows are the
 * neighbours a user sees and source-seq cursor pages do not return them in that order.
 * Prints one JSON line per row, each carrying the epoch its seqs belong to.
 */
export async function lookupTimelineRowsBySeq(
  client: DaemonClient,
  target: SeqLookupTarget,
  lookup: SeqLookup,
): Promise<string> {
  const timeline = await fetchSeqTimeline(client, target);
  return locateTimelineRows(timeline, lookup)
    .map(({ isTarget, row }) => JSON.stringify({ target: isTarget, epoch: timeline.epoch, ...row }))
    .join("\n");
}
