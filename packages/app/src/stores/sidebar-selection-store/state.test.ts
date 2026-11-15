import { describe, expect, it } from "vitest";
import {
  INACTIVE_SIDEBAR_SELECTION,
  resolveSidebarRowPressIntent,
  selectSidebarRange,
  startSidebarSelection,
  toggleSidebarSelection,
  type SidebarSelection,
} from "@/stores/sidebar-selection-store/state";

function ticked(selection: SidebarSelection): string[] {
  return selection.active ? [...selection.keys].sort() : [];
}

const VISIBLE = ["a", "b", "c", "d", "e"];
const NO_MODIFIERS = { toggle: false, shift: false };

describe("sidebar selection", () => {
  it("opens the row on a plain press until selection starts, then ticks it", () => {
    expect(
      resolveSidebarRowPressIntent({
        selection: INACTIVE_SIDEBAR_SELECTION,
        modifiers: NO_MODIFIERS,
      }),
    ).toBe("open");
    expect(
      resolveSidebarRowPressIntent({
        selection: startSidebarSelection(null),
        modifiers: NO_MODIFIERS,
      }),
    ).toBe("toggle");
  });

  it("treats Cmd/Ctrl as toggle and Shift as range whether or not selection is on", () => {
    expect(
      resolveSidebarRowPressIntent({
        selection: INACTIVE_SIDEBAR_SELECTION,
        modifiers: { toggle: true, shift: false },
      }),
    ).toBe("toggle");
    expect(
      resolveSidebarRowPressIntent({
        selection: startSidebarSelection("a"),
        modifiers: { toggle: false, shift: true },
      }),
    ).toBe("range");
  });

  it("toggles a row on and off, starting selection from a toggle", () => {
    const first = toggleSidebarSelection(INACTIVE_SIDEBAR_SELECTION, "b");
    expect(first.active).toBe(true);
    expect(ticked(first)).toEqual(["b"]);

    const second = toggleSidebarSelection(first, "d");
    expect(ticked(second)).toEqual(["b", "d"]);

    const third = toggleSidebarSelection(second, "b");
    expect(third.active).toBe(true);
    expect(ticked(third)).toEqual(["d"]);
  });

  it("selects a range from the last ticked row in either direction, keeping earlier ticks", () => {
    const start = toggleSidebarSelection(startSidebarSelection("a"), "d");
    const backward = selectSidebarRange(start, {
      key: "b",
      visibleKeys: VISIBLE,
      fallbackAnchorKey: null,
    });
    expect(ticked(backward)).toEqual(["a", "b", "c", "d"]);

    const forward = selectSidebarRange(backward, {
      key: "e",
      visibleKeys: VISIBLE,
      fallbackAnchorKey: null,
    });
    expect(ticked(forward)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("anchors a range on the open workspace when selection is off", () => {
    const selection = selectSidebarRange(INACTIVE_SIDEBAR_SELECTION, {
      key: "d",
      visibleKeys: VISIBLE,
      fallbackAnchorKey: "b",
    });
    expect(ticked(selection)).toEqual(["b", "c", "d"]);
  });

  it("never ticks rows that are not visible between the ends of the range", () => {
    const selection = selectSidebarRange(startSidebarSelection("a"), {
      key: "e",
      // "c" sits in a collapsed project, so it is not in the visible order.
      visibleKeys: ["a", "b", "d", "e"],
      fallbackAnchorKey: null,
    });
    expect(ticked(selection)).toEqual(["a", "b", "d", "e"]);
  });

  it("ticks only the pressed row when there is no visible anchor", () => {
    const selection = selectSidebarRange(INACTIVE_SIDEBAR_SELECTION, {
      key: "c",
      visibleKeys: VISIBLE,
      fallbackAnchorKey: "gone",
    });
    expect(ticked(selection)).toEqual(["c"]);
  });
});
