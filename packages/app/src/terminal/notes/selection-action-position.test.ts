import { describe, expect, it } from "vitest";

import { resolveSelectionActionPosition } from "./selection-action-position";

const SIZE = { width: 90, height: 28 };
const VIEW = { width: 800, height: 600 };

describe("resolveSelectionActionPosition", () => {
  it("sits below the selection, right-aligned with its end", () => {
    expect(
      resolveSelectionActionPosition({ ...VIEW, left: 100, right: 300, top: 40, bottom: 60 }, SIZE),
    ).toEqual({ left: 210, top: 66 });
  });

  it("flips above the selection when there is no room below", () => {
    expect(
      resolveSelectionActionPosition(
        { ...VIEW, left: 100, right: 300, top: 560, bottom: 580 },
        SIZE,
      ),
    ).toEqual({ left: 210, top: 526 });
  });

  it("stays inside the terminal horizontally", () => {
    expect(
      resolveSelectionActionPosition({ ...VIEW, left: 0, right: 20, top: 40, bottom: 60 }, SIZE)
        ?.left,
    ).toBe(4);
    expect(
      resolveSelectionActionPosition({ ...VIEW, left: 700, right: 900, top: 40, bottom: 60 }, SIZE)
        ?.left,
    ).toBe(706);
  });

  it("hides while the selection is scrolled out of view", () => {
    expect(
      resolveSelectionActionPosition({ ...VIEW, left: 0, right: 20, top: -40, bottom: -20 }, SIZE),
    ).toBeNull();
    expect(
      resolveSelectionActionPosition({ ...VIEW, left: 0, right: 20, top: 620, bottom: 640 }, SIZE),
    ).toBeNull();
  });
});
