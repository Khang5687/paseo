import { describe, expect, it } from "vitest";
import {
  clampDesktopDrawerHeight,
  DESKTOP_CHAT_MIN_HEIGHT,
  DESKTOP_DRAWER_MIN_HEIGHT,
  lastPrintedLine,
  neighborDrawerTerminalId,
  PHONE_DRAWER_BAR_HEIGHT,
  resolveActiveDrawerTerminalId,
  resolveDrawerToggle,
  selectChatTerminals,
  settlePhoneDrawerDrag,
  type DrawerTerminal,
} from "./model";

function terminal(id: string, ownerAgentId: string | null, createdAt: string | null) {
  return { id, name: id, title: id, ownerAgentId, createdAt } as DrawerTerminal;
}

describe("chat terminal drawer model", () => {
  it("shows only the chat's own terminals, oldest first, so tabs keep their places", () => {
    const terminals = [
      terminal("c", "agent-a", "2026-01-03T00:00:00Z"),
      terminal("tab", null, "2026-01-01T00:00:00Z"),
      terminal("a", "agent-a", "2026-01-01T00:00:00Z"),
      terminal("other", "agent-b", "2026-01-02T00:00:00Z"),
      terminal("b", "agent-a", "2026-01-02T00:00:00Z"),
    ];

    expect(selectChatTerminals(terminals, "agent-a").map((entry) => entry.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("keeps the remembered terminal while it lives and falls back to the newest one", () => {
    const terminals = [terminal("a", "agent-a", null), terminal("b", "agent-a", null)];

    expect(resolveActiveDrawerTerminalId(terminals, "a")).toBe("a");
    expect(resolveActiveDrawerTerminalId(terminals, "killed")).toBe("b");
    expect(resolveActiveDrawerTerminalId([], "a")).toBeNull();
  });

  it("swipes to the next or previous tab and stops at the ends", () => {
    const terminals = ["a", "b", "c"].map((id) => terminal(id, "agent-a", null));

    expect(neighborDrawerTerminalId(terminals, "b", 1)).toBe("c");
    expect(neighborDrawerTerminalId(terminals, "b", -1)).toBe("a");
    expect(neighborDrawerTerminalId(terminals, "c", 1)).toBeNull();
    expect(neighborDrawerTerminalId(terminals, "a", -1)).toBeNull();
  });

  it("toggles like VS Code: open, then focus, then close", () => {
    expect(resolveDrawerToggle({ open: false, focused: false })).toBe("open");
    expect(resolveDrawerToggle({ open: true, focused: false })).toBe("focus");
    expect(resolveDrawerToggle({ open: true, focused: true })).toBe("close");
  });

  it("keeps a resized desktop drawer between its minimum and the chat's minimum", () => {
    expect(clampDesktopDrawerHeight(10, 800)).toBe(DESKTOP_DRAWER_MIN_HEIGHT);
    expect(clampDesktopDrawerHeight(790, 800)).toBe(800 - DESKTOP_CHAT_MIN_HEIGHT);
    expect(clampDesktopDrawerHeight(300.4, 800)).toBe(300);
  });

  it("settles a slow phone drag on the nearest snap", () => {
    const containerHeight = 800;
    const settle = (height: number) =>
      settlePhoneDrawerDrag({ from: "half", height, velocityY: 0, containerHeight });

    expect(settle(PHONE_DRAWER_BAR_HEIGHT + 20)).toBe("bar");
    expect(settle(420)).toBe("half");
    expect(settle(760)).toBe("full");
  });

  it("moves a flicked phone sheet one snap from where the drag started", () => {
    const containerHeight = 800;

    expect(
      settlePhoneDrawerDrag({ from: "half", height: 390, velocityY: -1200, containerHeight }),
    ).toBe("full");
    expect(
      settlePhoneDrawerDrag({ from: "half", height: 410, velocityY: 1200, containerHeight }),
    ).toBe("bar");
    expect(
      settlePhoneDrawerDrag({ from: "bar", height: 44, velocityY: 1200, containerHeight }),
    ).toBe("bar");
  });

  it("shows the last line with text in the thin bar", () => {
    expect(lastPrintedLine(["$ npm test", "  12 passed  ", "", "   "])).toBe("12 passed");
    expect(lastPrintedLine(["", ""])).toBe("");
  });
});
