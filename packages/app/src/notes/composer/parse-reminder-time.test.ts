import { describe, expect, it } from "vitest";
import { parseReminderTime, resolveReminderPreset } from "./parse-reminder-time";

// Wednesday 10 June 2026, 14:00 local time; far from any DST change.
const NOW = new Date(2026, 5, 10, 14, 0, 0, 0);

function local(day: number, hour: number, minute = 0): Date {
  return new Date(2026, 5, day, hour, minute, 0, 0);
}

function minutesFromNow(minutes: number): Date {
  return new Date(NOW.getTime() + minutes * 60_000);
}

describe("parseReminderTime", () => {
  it.each([
    ["3pm", local(10, 15)],
    ["3 PM", local(10, 15)],
    ["3:30pm", local(10, 15, 30)],
    ["15:30", local(10, 15, 30)],
    ["at 3pm", local(10, 15)],
    ["at 15:30", local(10, 15, 30)],
    ["at 15", local(10, 15)],
    ["noon", local(11, 12)],
    ["midnight", local(11, 0)],
  ])("reads the clock time %s", (input, expected) => {
    expect(parseReminderTime(input, NOW)).toEqual(expected);
  });

  it.each([
    ["9am", local(11, 9)],
    ["13:59", local(11, 13, 59)],
    ["2pm", local(11, 14)],
    ["at 8:15", local(11, 8, 15)],
  ])("rolls the past clock time %s over to tomorrow", (input, expected) => {
    expect(parseReminderTime(input, NOW)).toEqual(expected);
  });

  it.each([
    ["in 2 hours", minutesFromNow(120)],
    ["in 45m", minutesFromNow(45)],
    ["in 45 min", minutesFromNow(45)],
    ["in 1 hour", minutesFromNow(60)],
    ["in an hour", minutesFromNow(60)],
    ["in half an hour", minutesFromNow(30)],
    ["in 1h 30m", minutesFromNow(90)],
    ["in 1 hour and 15 minutes", minutesFromNow(75)],
    ["in 1.5h", minutesFromNow(90)],
    ["in 2 days", minutesFromNow(2 * 24 * 60)],
    ["45m", minutesFromNow(45)],
  ])("reads the relative time %s", (input, expected) => {
    expect(parseReminderTime(input, NOW)).toEqual(expected);
  });

  it.each([
    ["tomorrow 9am", local(11, 9)],
    ["tomorrow at 9am", local(11, 9)],
    ["tomorrow 15:00", local(11, 15)],
    ["tomorrow 9", local(11, 9)],
    ["9am tomorrow", local(11, 9)],
    ["tomorrow", local(11, 9)],
    ["today 5pm", local(10, 17)],
    ["tonight at 9pm", local(10, 21)],
  ])("reads the day-qualified time %s", (input, expected) => {
    expect(parseReminderTime(input, NOW)).toEqual(expected);
  });

  it("keeps a clock time later today on today", () => {
    expect(parseReminderTime("14:01", NOW)).toEqual(local(10, 14, 1));
  });

  it("does not roll an explicit today that already passed", () => {
    expect(parseReminderTime("today 9am", NOW)).toBeNull();
  });

  it.each(["", "   ", "soon", "15", "3", "in 5", "13pm", "25:00", "10:75", "in 0m", "am", "in"])(
    "rejects %j",
    (input) => {
      expect(parseReminderTime(input, NOW)).toBeNull();
    },
  );
});

describe("resolveReminderPreset", () => {
  it("resolves relative presets from now", () => {
    expect(resolveReminderPreset("in30m", NOW)).toEqual(minutesFromNow(30));
    expect(resolveReminderPreset("in1h", NOW)).toEqual(minutesFromNow(60));
    expect(resolveReminderPreset("in2h", NOW)).toEqual(minutesFromNow(120));
  });

  it("resolves tomorrow 9:00 to the next calendar day", () => {
    expect(resolveReminderPreset("tomorrow9", NOW)).toEqual(local(11, 9));
    expect(resolveReminderPreset("tomorrow9", new Date(2026, 5, 30, 23, 30))).toEqual(
      new Date(2026, 6, 1, 9, 0, 0, 0),
    );
  });
});
