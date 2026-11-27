import { describe, expect, it } from "vitest";
import {
  nextSnoozeWakeMs,
  projectSnoozedUntilMs,
  snoozeUntilDate,
  snoozeUntilMonday,
  snoozeUntilTomorrow,
} from "./project-snooze";

// Local time on purpose: snoozes wake at 08:00 where the user is.
const WEDNESDAY_NIGHT = new Date(2026, 10, 25, 23, 30);
const MONDAY_MORNING = new Date(2026, 10, 30, 7, 0);

describe("project snooze", () => {
  it("wakes tomorrow and on Monday at 08:00 local time", () => {
    expect(snoozeUntilTomorrow(WEDNESDAY_NIGHT)).toEqual(new Date(2026, 10, 26, 8, 0));
    expect(snoozeUntilMonday(WEDNESDAY_NIGHT)).toEqual(new Date(2026, 10, 30, 8, 0));
    // On a Monday, "Monday" is next week's, never an hour from now.
    expect(snoozeUntilMonday(MONDAY_MORNING)).toEqual(new Date(2026, 11, 7, 8, 0));
  });

  it("takes a picked day at 08:00 and refuses one already past", () => {
    expect(snoozeUntilDate("2026-12-01", WEDNESDAY_NIGHT)).toEqual(new Date(2026, 11, 1, 8, 0));
    expect(snoozeUntilDate("2026-11-25", WEDNESDAY_NIGHT)).toBeNull();
    expect(snoozeUntilDate("not a day", WEDNESDAY_NIGHT)).toBeNull();
  });

  it("counts a project snoozed while any host still is, and wakes it once the time passes", () => {
    const now = WEDNESDAY_NIGHT.getTime();
    const later = new Date(now + 60_000).toISOString();
    const past = new Date(now - 60_000).toISOString();
    expect(projectSnoozedUntilMs([{ snoozedUntil: past }, { snoozedUntil: later }], now)).toBe(
      now + 60_000,
    );
    expect(projectSnoozedUntilMs([{ snoozedUntil: past }, { snoozedUntil: null }], now)).toBeNull();
    expect(
      nextSnoozeWakeMs(
        [
          { hosts: [{ snoozedUntil: new Date(now + 120_000).toISOString() }] },
          { hosts: [{ snoozedUntil: later }] },
          { hosts: [{ snoozedUntil: past }] },
        ],
        now,
      ),
    ).toBe(now + 60_000);
  });
});
