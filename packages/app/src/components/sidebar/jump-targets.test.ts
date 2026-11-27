import { describe, expect, it } from "vitest";
import {
  buildRecentWalk,
  countOtherWaiting,
  pushRecentWorkspace,
  resolveWaitingWorkspaces,
  stepWalkIndex,
} from "./jump-targets";

const ws = (workspaceId: string, serverId = "srv") => ({ serverId, workspaceId });

describe("pushRecentWorkspace", () => {
  it("moves a revisited workspace to the front without duplicating it", () => {
    expect(pushRecentWorkspace([ws("a"), ws("b"), ws("c")], ws("c"))).toEqual([
      ws("c"),
      ws("a"),
      ws("b"),
    ]);
  });

  it("keeps the list when the workspace is already newest", () => {
    const recent = [ws("a"), ws("b")];
    expect(pushRecentWorkspace(recent, ws("a"))).toBe(recent);
  });

  it("drops the oldest past the limit", () => {
    expect(pushRecentWorkspace([ws("a"), ws("b")], ws("c"), 2)).toEqual([ws("c"), ws("a")]);
  });

  it("tells hosts apart", () => {
    expect(pushRecentWorkspace([ws("a", "one")], ws("a", "two"))).toHaveLength(2);
  });
});

describe("buildRecentWalk", () => {
  it("starts at the open workspace and skips workspaces the sidebar does not list", () => {
    const listed = new Set(["b", "d"]);
    expect(
      buildRecentWalk({
        recent: [ws("b"), ws("c"), ws("d")],
        current: ws("a"),
        isListed: (entry) => listed.has(entry.workspaceId),
      }),
    ).toEqual([ws("a"), ws("b"), ws("d")]);
  });
});

describe("stepWalkIndex", () => {
  it("wraps in both directions", () => {
    expect(stepWalkIndex(2, 1, 3)).toBe(0);
    expect(stepWalkIndex(0, -1, 3)).toBe(2);
  });
});

describe("resolveWaitingWorkspaces", () => {
  it("lists only workspaces waiting on you, the longest wait first", () => {
    expect(
      resolveWaitingWorkspaces([
        { ...ws("new"), statusBucket: "needs_input", statusEnteredAt: new Date(300) },
        { ...ws("busy"), statusBucket: "running", statusEnteredAt: new Date(100) },
        { ...ws("old"), statusBucket: "needs_input", statusEnteredAt: new Date(200) },
      ]),
    ).toEqual([ws("old"), ws("new")]);
  });
});

describe("countOtherWaiting", () => {
  it("leaves out the workspace that is already open", () => {
    expect(countOtherWaiting([ws("a"), ws("b")], ws("a"))).toBe(1);
    expect(countOtherWaiting([ws("a"), ws("b")], null)).toBe(2);
  });
});
