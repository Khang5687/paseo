import { expect, test } from "vitest";
import { backgroundWorkText, tallyBackgroundWork } from "./presentation";

test("shows descriptions and commands once, with useful fallbacks", () => {
  expect(
    backgroundWorkText({ description: "Watch build", command: "tail -f build.log" }, "Monitor"),
  ).toEqual({ title: "Watch build", command: "tail -f build.log" });
  expect(backgroundWorkText({ description: null, command: "sleep 10" }, "Shell")).toEqual({
    title: "sleep 10",
    command: null,
  });
  expect(backgroundWorkText({ description: "sleep 10", command: "sleep 10" }, "Shell")).toEqual({
    title: "sleep 10",
    command: null,
  });
  expect(backgroundWorkText({ description: null }, "Shell")).toEqual({
    title: "Shell",
    command: null,
  });
});

test("a heartbeat waits for its time instead of counting as running work", () => {
  const shell = {};
  const weekly = { nextRunAt: "2026-06-06T09:00:00.000Z" };
  const hourly = { nextRunAt: "2026-06-01T11:00:00.000Z" };
  expect(tallyBackgroundWork([weekly], { count: 1, runningCount: 0 })).toEqual({
    running: 0,
    scheduled: 1,
    nextRunAt: weekly.nextRunAt,
  });
  expect(tallyBackgroundWork([shell, weekly, hourly], { count: 3, runningCount: 1 })).toEqual({
    running: 1,
    scheduled: 2,
    nextRunAt: hourly.nextRunAt,
  });
});

test("before the list loads, the agent summary decides what spins", () => {
  expect(
    tallyBackgroundWork(null, { count: 1, runningCount: 0, nextRunAt: "2026-06-06T09:00:00.000Z" }),
  ).toEqual({ running: 0, scheduled: 1, nextRunAt: "2026-06-06T09:00:00.000Z" });
  expect(tallyBackgroundWork(null, { count: 2 })).toEqual({
    running: 2,
    scheduled: 0,
    nextRunAt: null,
  });
});
