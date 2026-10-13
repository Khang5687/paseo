import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  QUIT_CONFIRM_WINDOW_MS,
  QUIT_HOLD_MS,
  createQuitConfirm,
  isQuitShortcut,
} from "./policy.js";

const KEY_REPEAT_MS = 30;

function createHarness() {
  const events: string[] = [];
  const confirm = createQuitConfirm({
    showToast: () => events.push("show"),
    hideToast: () => events.push("hide"),
    quit: () => events.push("quit"),
  });
  return { events, confirm };
}

// Auto-repeat keyDowns every KEY_REPEAT_MS, with the last one landing exactly at durationMs.
function holdFor(confirm: { press(input: { repeat: boolean }): void }, durationMs: number): void {
  let elapsed = 0;
  while (elapsed < durationMs) {
    const step = Math.min(KEY_REPEAT_MS, durationMs - elapsed);
    vi.advanceTimersByTime(step);
    elapsed += step;
    confirm.press({ repeat: true });
  }
}

describe("quit confirm", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("a single press shows the toast and does not quit", () => {
    const { events, confirm } = createHarness();

    confirm.press({ repeat: false });
    vi.advanceTimersByTime(QUIT_CONFIRM_WINDOW_MS);

    expect(events).toEqual(["show", "hide"]);
  });

  test("a second press while the toast is up quits", () => {
    const { events, confirm } = createHarness();

    confirm.press({ repeat: false });
    vi.advanceTimersByTime(QUIT_CONFIRM_WINDOW_MS - 1);
    confirm.press({ repeat: false });

    expect(events).toEqual(["show", "hide", "quit"]);
  });

  test("a second press after the toast expired starts over", () => {
    const { events, confirm } = createHarness();

    confirm.press({ repeat: false });
    vi.advanceTimersByTime(QUIT_CONFIRM_WINDOW_MS);
    confirm.press({ repeat: false });

    expect(events).toEqual(["show", "hide", "show"]);
  });

  test("holding quits once the hold duration elapses, not before", () => {
    const { events, confirm } = createHarness();

    confirm.press({ repeat: false });
    holdFor(confirm, QUIT_HOLD_MS - 1);
    expect(events).toEqual(["show"]);

    holdFor(confirm, 1);
    expect(events).toEqual(["show", "hide", "quit"]);
  });

  test("a late first repeat from slow key repeat settings still counts as a hold", () => {
    const { events, confirm } = createHarness();

    confirm.press({ repeat: false });
    vi.advanceTimersByTime(QUIT_CONFIRM_WINDOW_MS - 1);
    confirm.press({ repeat: true });

    expect(events).toEqual(["show", "hide", "quit"]);
  });

  test("releasing a short hold leaves the toast up for a second press", () => {
    const { events, confirm } = createHarness();

    confirm.press({ repeat: false });
    holdFor(confirm, QUIT_HOLD_MS / 2);
    vi.advanceTimersByTime(QUIT_CONFIRM_WINDOW_MS - 1);
    expect(events).toEqual(["show"]);

    confirm.press({ repeat: false });
    expect(events).toEqual(["show", "hide", "quit"]);
  });
});

describe("isQuitShortcut", () => {
  const base = { type: "keyDown", key: "q", meta: true, control: false, alt: false, shift: false };

  test("matches Cmd+Q keyDown only", () => {
    expect(isQuitShortcut(base)).toBe(true);
    expect(isQuitShortcut({ ...base, key: "Q" })).toBe(true);
    expect(isQuitShortcut({ ...base, type: "keyUp" })).toBe(false);
    expect(isQuitShortcut({ ...base, meta: false })).toBe(false);
    expect(isQuitShortcut({ ...base, shift: true })).toBe(false);
    expect(isQuitShortcut({ ...base, alt: true })).toBe(false);
    expect(isQuitShortcut({ ...base, control: true })).toBe(false);
    expect(isQuitShortcut({ ...base, key: "w" })).toBe(false);
  });
});
