import { describe, expect, it } from "vitest";
import {
  sliderFraction,
  sliderValueAtPosition,
  sliderValueForKey,
  snapSliderValue,
} from "./slider-math";

const PERCENT = { min: 0, max: 100, step: 1 };
const BLUR = { min: 0, max: 32, step: 1 };

describe("snapSliderValue", () => {
  it("clamps into the range", () => {
    expect(snapSliderValue(140, PERCENT)).toBe(100);
    expect(snapSliderValue(-3, PERCENT)).toBe(0);
  });

  it("rounds to the nearest step measured from min", () => {
    expect(snapSliderValue(41.4, PERCENT)).toBe(41);
    expect(snapSliderValue(41.5, PERCENT)).toBe(42);
    expect(snapSliderValue(7, { min: 1, max: 21, step: 5 })).toBe(6);
  });

  it("keeps fractional steps free of float error", () => {
    expect(snapSliderValue(0.30000000000000004, { min: 0, max: 1, step: 0.1 })).toBe(0.3);
    expect(snapSliderValue(0.7, { min: 0, max: 1, step: 0.1 })).toBe(0.7);
  });

  it("never steps past a max that is off the step grid", () => {
    expect(snapSliderValue(9.9, { min: 0, max: 10, step: 3 })).toBe(9);
    expect(snapSliderValue(10, { min: 0, max: 10, step: 4 })).toBe(10);
  });
});

describe("sliderFraction", () => {
  it("maps min and max to the track ends", () => {
    expect(sliderFraction(0, BLUR)).toBe(0);
    expect(sliderFraction(16, BLUR)).toBe(0.5);
    expect(sliderFraction(32, BLUR)).toBe(1);
  });

  it("clamps out-of-range values and tolerates an empty range", () => {
    expect(sliderFraction(40, BLUR)).toBe(1);
    expect(sliderFraction(5, { min: 5, max: 5, step: 1 })).toBe(0);
  });
});

describe("sliderValueAtPosition", () => {
  // 220 wide with a 10 px inset: the thumb's center travels across 200 px.
  const width = 220;
  const inset = 10;

  it("maps the thumb's travel onto the range", () => {
    expect(sliderValueAtPosition(10, width, inset, PERCENT)).toBe(0);
    expect(sliderValueAtPosition(110, width, inset, PERCENT)).toBe(50);
    expect(sliderValueAtPosition(210, width, inset, PERCENT)).toBe(100);
  });

  it("lands on the end values from the inset strips", () => {
    expect(sliderValueAtPosition(2, width, inset, PERCENT)).toBe(0);
    expect(sliderValueAtPosition(218, width, inset, PERCENT)).toBe(100);
    expect(sliderValueAtPosition(-40, width, inset, PERCENT)).toBe(0);
  });

  it("snaps to steps", () => {
    // 1 px of travel is 0.16 px of blur.
    expect(sliderValueAtPosition(10 + 103, width, inset, BLUR)).toBe(16);
  });

  it("returns min before the track has been measured", () => {
    expect(sliderValueAtPosition(50, 0, inset, PERCENT)).toBe(0);
  });
});

describe("sliderValueForKey", () => {
  it("steps with the arrow keys and clamps at the ends", () => {
    expect(sliderValueForKey("ArrowRight", 40, PERCENT)).toBe(41);
    expect(sliderValueForKey("ArrowUp", 40, PERCENT)).toBe(41);
    expect(sliderValueForKey("ArrowLeft", 40, PERCENT)).toBe(39);
    expect(sliderValueForKey("ArrowDown", 0, PERCENT)).toBe(0);
    expect(sliderValueForKey("ArrowRight", 100, PERCENT)).toBe(100);
  });

  it("pages by ten steps and jumps with Home and End", () => {
    expect(sliderValueForKey("PageUp", 95, PERCENT)).toBe(100);
    expect(sliderValueForKey("PageDown", 30, PERCENT)).toBe(20);
    expect(sliderValueForKey("Home", 30, BLUR)).toBe(0);
    expect(sliderValueForKey("End", 3, BLUR)).toBe(32);
  });

  it("ignores other keys", () => {
    expect(sliderValueForKey("Enter", 30, PERCENT)).toBeNull();
    expect(sliderValueForKey("a", 30, PERCENT)).toBeNull();
  });
});
