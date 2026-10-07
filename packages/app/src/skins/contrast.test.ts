import { describe, expect, it } from "vitest";
import {
  blendOver,
  computeGateAlpha,
  contrastRatio,
  grayForLuminance,
  parseColor,
  relativeLuminance,
} from "./contrast";

const DARK_MUTED = parseColor("#A1A5A4");
const DARK_BASE = parseColor("#181B1A");
const LIGHT_MUTED = parseColor("#71717a");
const LIGHT_BASE = parseColor("#ffffff");

describe("parseColor", () => {
  it("parses hex forms", () => {
    expect(parseColor("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor("#181B1A")).toEqual({ r: 24, g: 27, b: 26, a: 1 });
    expect(parseColor("#00000080").a).toBeCloseTo(128 / 255, 5);
  });

  it("parses rgb and rgba", () => {
    expect(parseColor("rgb(10, 20, 30)")).toEqual({ r: 10, g: 20, b: 30, a: 1 });
    expect(parseColor("rgba(10, 20, 30, 0.5)")).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
  });

  it("rejects unsupported colors", () => {
    expect(() => parseColor("red")).toThrow();
  });
});

describe("wcag math", () => {
  it("matches the reference extremes", () => {
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 6);
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBe(0);
    expect(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 })).toBeCloseTo(21, 6);
  });

  it("round-trips gray luminance", () => {
    for (const luminance of [0, 0.05, 0.2, 0.5, 1]) {
      expect(relativeLuminance(grayForLuminance(luminance))).toBeCloseTo(luminance, 6);
    }
  });

  it("blends in gamma-encoded space", () => {
    const blended = blendOver({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }, 0.5);
    expect(blended.r).toBeCloseTo(127.5, 6);
  });
});

describe("computeGateAlpha", () => {
  it("needs about 0.86 for Paseo dark muted text over white art", () => {
    const alpha = computeGateAlpha({
      text: DARK_MUTED,
      base: DARK_BASE,
      artLuminance: 1,
      target: 4.5,
    });
    expect(alpha).toBeGreaterThan(0.85);
    expect(alpha).toBeLessThan(0.87);
  });

  it("returns the smallest passing alpha", () => {
    const alpha = computeGateAlpha({
      text: DARK_MUTED,
      base: DARK_BASE,
      artLuminance: 1,
      target: 4.5,
    });
    const art = grayForLuminance(1);
    expect(contrastRatio(DARK_MUTED, blendOver(DARK_BASE, art, alpha))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(DARK_MUTED, blendOver(DARK_BASE, art, alpha - 0.002))).toBeLessThan(4.5);
  });

  it("lowers alpha when the art is darker", () => {
    const white = computeGateAlpha({
      text: DARK_MUTED,
      base: DARK_BASE,
      artLuminance: 1,
      target: 4.5,
    });
    const gray = computeGateAlpha({
      text: DARK_MUTED,
      base: DARK_BASE,
      artLuminance: 0.3,
      target: 4.5,
    });
    expect(gray).toBeLessThan(white);
  });

  it("needs no scrim when the art is already dark enough", () => {
    expect(
      computeGateAlpha({ text: DARK_MUTED, base: DARK_BASE, artLuminance: 0.02, target: 4.5 }),
    ).toBe(0);
  });

  it("needs more alpha for target 7 than 4.5", () => {
    const normal = computeGateAlpha({
      text: DARK_MUTED,
      base: DARK_BASE,
      artLuminance: 1,
      target: 4.5,
    });
    const more = computeGateAlpha({
      text: DARK_MUTED,
      base: DARK_BASE,
      artLuminance: 1,
      target: 7,
    });
    expect(more).toBeGreaterThan(normal);
    expect(more).toBeLessThanOrEqual(1);
  });

  it("gates light themes against the darkest art", () => {
    const black = computeGateAlpha({
      text: LIGHT_MUTED,
      base: LIGHT_BASE,
      artLuminance: 0,
      target: 4.5,
    });
    const bright = computeGateAlpha({
      text: LIGHT_MUTED,
      base: LIGHT_BASE,
      artLuminance: 0.6,
      target: 4.5,
    });
    expect(black).toBeGreaterThan(0.3);
    expect(black).toBeLessThan(1);
    expect(bright).toBeLessThan(black);
  });

  it("returns 1 when the opaque surface itself fails", () => {
    expect(
      computeGateAlpha({
        text: parseColor("#777777"),
        base: LIGHT_BASE,
        artLuminance: 0,
        target: 7,
      }),
    ).toBe(1);
  });
});
