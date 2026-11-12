import { describe, expect, it } from "vitest";
import type { FetchAgentTimelinePayload } from "@getpaseo/client/internal/daemon-client";
import { locateTimelineRows, type SeqTimeline } from "./logs-seq.js";

type AgentTimelineEntry = FetchAgentTimelinePayload["entries"][number];

function entry(
  item: AgentTimelineEntry["item"],
  sourceSeqRanges: AgentTimelineEntry["sourceSeqRanges"],
): AgentTimelineEntry {
  return {
    provider: "claude",
    item,
    timestamp: "2026-10-09T10:00:00.000Z",
    seqStart: sourceSeqRanges[0].startSeq,
    seqEnd: sourceSeqRanges[sourceSeqRanges.length - 1].endSeq,
    sourceSeqRanges,
    collapsed: [],
  };
}

const prompt = entry({ type: "user_message", text: "fix the build" }, [{ startSeq: 1, endSeq: 1 }]);
// The tool call keeps its display slot at seq 2; its completion arrives at seq 9,
// after the assistant chunks it is displayed above.
const toolCall = entry(
  {
    type: "tool_call",
    callId: "call-1",
    name: "Bash",
    detail: { type: "plain_text", text: "npm run build" },
    status: "completed",
    error: null,
  },
  [
    { startSeq: 2, endSeq: 2 },
    { startSeq: 9, endSeq: 9 },
  ],
);
const mergedReply = entry({ type: "assistant_message", text: "The build is broken because…" }, [
  { startSeq: 3, endSeq: 8 },
]);
const followUp = entry({ type: "user_message", text: "thanks" }, [{ startSeq: 10, endSeq: 10 }]);
const finalReply = entry({ type: "assistant_message", text: "You're welcome." }, [
  { startSeq: 11, endSeq: 12 },
]);

const timeline: SeqTimeline<AgentTimelineEntry> = {
  epoch: "epoch-2",
  window: { minSeq: 1, maxSeq: 12, nextSeq: 13 },
  rows: [prompt, toolCall, mergedReply, followUp, finalReply],
};

describe("locateTimelineRows", () => {
  it("resolves a seq inside a merged assistant row to that row", () => {
    expect(locateTimelineRows(timeline, { seq: 5, epoch: "epoch-2", context: 0 })).toEqual([
      { isTarget: true, row: mergedReply },
    ]);
  });

  it("resolves a tool completion seq to the tool row, not the row displayed between its ranges", () => {
    expect(locateTimelineRows(timeline, { seq: 9, epoch: null, context: 0 })).toEqual([
      { isTarget: true, row: toolCall },
    ]);
  });

  it("prints context rows in display order around the target", () => {
    expect(locateTimelineRows(timeline, { seq: 5, epoch: null, context: 1 })).toEqual([
      { isTarget: false, row: toolCall },
      { isTarget: true, row: mergedReply },
      { isTarget: false, row: followUp },
    ]);
  });

  it("clamps context at the start and end of the timeline", () => {
    expect(locateTimelineRows(timeline, { seq: 1, epoch: null, context: 2 })).toEqual([
      { isTarget: true, row: prompt },
      { isTarget: false, row: toolCall },
      { isTarget: false, row: mergedReply },
    ]);
    expect(locateTimelineRows(timeline, { seq: 12, epoch: null, context: 2 })).toEqual([
      { isTarget: false, row: mergedReply },
      { isTarget: false, row: followUp },
      { isTarget: true, row: finalReply },
    ]);
  });

  it("rejects a seq past the timeline head", () => {
    expect(() => locateTimelineRows(timeline, { seq: 13, epoch: null, context: 0 })).toThrow(
      "seq 13 is past the timeline head: the latest seq in epoch epoch-2 is 12.",
    );
  });

  it("rejects a reference from another epoch and names both epochs", () => {
    expect(() => locateTimelineRows(timeline, { seq: 5, epoch: "epoch-1", context: 0 })).toThrow(
      "Epoch mismatch: the reference is from epoch epoch-1, but the timeline is now at epoch epoch-2.",
    );
  });
});
