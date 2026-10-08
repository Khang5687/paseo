import { describe, expect, it } from "vitest";
import {
  focalFromPoint,
  isSkinSelected,
  nearestVisibilityPercent,
  skinNameFromFileName,
} from "./selection";

describe("isSkinSelected", () => {
  const selection = { light: "local:a", dark: "local:b" };

  it("requires both schemes to match for the both target", () => {
    expect(isSkinSelected(selection, "local:a", "both")).toBe(false);
    expect(isSkinSelected({ light: "local:a", dark: "local:a" }, "local:a", "both")).toBe(true);
    expect(isSkinSelected({ light: null, dark: null }, null, "both")).toBe(true);
  });

  it("checks only the targeted scheme otherwise", () => {
    expect(isSkinSelected(selection, "local:a", "light")).toBe(true);
    expect(isSkinSelected(selection, "local:a", "dark")).toBe(false);
    expect(isSkinSelected(selection, null, "dark")).toBe(false);
  });
});

describe("nearestVisibilityPercent", () => {
  it("snaps to the nearest step", () => {
    expect(nearestVisibilityPercent(1)).toBe(100);
    expect(nearestVisibilityPercent(0.6)).toBe(50);
    expect(nearestVisibilityPercent(0.7)).toBe(75);
    expect(nearestVisibilityPercent(0)).toBe(25);
  });
});

describe("skinNameFromFileName", () => {
  it("strips the extension and falls back when empty", () => {
    expect(skinNameFromFileName("sunset.png", "Image")).toBe("sunset");
    expect(skinNameFromFileName(null, "Image")).toBe("Image");
    expect(skinNameFromFileName(".png", "Image")).toBe("Image");
  });
});

describe("focalFromPoint", () => {
  it("normalizes and clamps", () => {
    expect(focalFromPoint({ x: 50, y: 25 }, { width: 200, height: 100 })).toEqual({
      x: 0.25,
      y: 0.25,
    });
    expect(focalFromPoint({ x: -5, y: 500 }, { width: 200, height: 100 })).toEqual({ x: 0, y: 1 });
    expect(focalFromPoint({ x: 1, y: 1 }, { width: 0, height: 0 })).toEqual({
      x: 0.5,
      y: 0.5,
    });
  });
});
