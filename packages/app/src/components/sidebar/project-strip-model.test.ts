import { describe, expect, it } from "vitest";
import {
  listProjectEndMoves,
  listProjectStripMoves,
  moveProjectStripEntry,
  resolveProjectStripShortcutKeys,
} from "./project-strip-model";

const KEYS = ["a", "b", "c", "d"];

describe("project strip shortcut keys", () => {
  it("gives the digit keys nothing while the strip is hidden for a single project", () => {
    expect(resolveProjectStripShortcutKeys(["only"])).toEqual([]);
  });

  it("numbers the first nine projects in strip order", () => {
    const keys = Array.from({ length: 11 }, (_, index) => `p${index}`);
    expect(resolveProjectStripShortcutKeys(keys)).toEqual(keys.slice(0, 9));
  });
});

describe("project strip menu moves", () => {
  it("offers only the moves that change the order, without repeating a one-step move", () => {
    expect(listProjectStripMoves({ projectKeys: KEYS, viewKey: "a" })).toEqual(["later", "bottom"]);
    // From second place, moving earlier already makes it first.
    expect(listProjectStripMoves({ projectKeys: KEYS, viewKey: "b" })).toEqual([
      "earlier",
      "later",
      "bottom",
    ]);
    // From second-to-last place, moving later already makes it last.
    expect(listProjectStripMoves({ projectKeys: KEYS, viewKey: "c" })).toEqual([
      "top",
      "earlier",
      "later",
    ]);
    expect(listProjectStripMoves({ projectKeys: KEYS, viewKey: "d" })).toEqual(["top", "earlier"]);
  });

  it("offers both end moves beside a drag whenever they change the order", () => {
    expect(listProjectEndMoves({ projectKeys: KEYS, viewKey: "a" })).toEqual(["bottom"]);
    expect(listProjectEndMoves({ projectKeys: KEYS, viewKey: "b" })).toEqual(["top", "bottom"]);
    expect(listProjectEndMoves({ projectKeys: KEYS, viewKey: "d" })).toEqual(["top"]);
    expect(listProjectEndMoves({ projectKeys: ["only"], viewKey: "only" })).toEqual([]);
  });

  it.each([
    { viewKey: "c", move: "top" as const, expected: ["c", "a", "b", "d"] },
    { viewKey: "c", move: "earlier" as const, expected: ["a", "c", "b", "d"] },
    { viewKey: "b", move: "later" as const, expected: ["a", "c", "b", "d"] },
    { viewKey: "a", move: "bottom" as const, expected: ["b", "c", "d", "a"] },
  ])("moves $viewKey $move", ({ viewKey, move, expected }) => {
    expect(moveProjectStripEntry({ projectKeys: KEYS, viewKey, move })).toEqual(expected);
  });
});
