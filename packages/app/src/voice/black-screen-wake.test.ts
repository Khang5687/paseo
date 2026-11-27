import { describe, expect, it } from "vitest";
import { registerWakeTap, type WakeTap } from "./black-screen-wake";

function tap(at: number, x = 100, y = 200, holdMs = 60, move = 0): WakeTap {
  return { start: { x, y, at }, end: { x: x + move, y, at: at + holdMs } };
}

function run(taps: WakeTap[]): boolean[] {
  let pending: WakeTap | null = null;
  return taps.map((next) => {
    const result = registerWakeTap(pending, next);
    pending = result.pending;
    return result.wake;
  });
}

describe("registerWakeTap", () => {
  it("does not wake on a single tap", () => {
    expect(run([tap(0)])).toEqual([false]);
  });

  it("wakes on two quick taps in the same place", () => {
    expect(run([tap(0), tap(250)])).toEqual([false, true]);
  });

  it("does not wake when the second tap comes too late", () => {
    expect(run([tap(0), tap(500)])).toEqual([false, false]);
  });

  it("does not wake when the two taps land far apart", () => {
    expect(run([tap(0, 100, 200), tap(200, 300, 600)])).toEqual([false, false]);
  });

  it("does not count a long press as a tap", () => {
    expect(run([tap(0, 100, 200, 600), tap(700)])).toEqual([false, false]);
    expect(run([tap(0), tap(150, 100, 200, 600)])).toEqual([false, false]);
  });

  it("does not count a drag as a tap", () => {
    expect(run([tap(0, 100, 200, 60, 80), tap(150)])).toEqual([false, false]);
  });

  it("starts over after a wake, so a third tap does not wake again", () => {
    expect(run([tap(0), tap(200), tap(400)])).toEqual([false, true, false]);
  });

  it("lets a late tap start a new pair", () => {
    expect(run([tap(0), tap(800), tap(1000)])).toEqual([false, false, true]);
  });
});
