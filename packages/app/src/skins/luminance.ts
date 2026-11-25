import type { SkinLuminance } from "./types";

export function srgbChannelToLinear(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.x relative luminance of an 8-bit sRGB color. */
export function relativeLuminance(red: number, green: number, blue: number): number {
  return (
    0.2126 * srgbChannelToLinear(red) +
    0.7152 * srgbChannelToLinear(green) +
    0.0722 * srgbChannelToLinear(blue)
  );
}

function percentile(sortedAscending: Float64Array, fraction: number): number {
  const index = Math.round(fraction * (sortedAscending.length - 1));
  return sortedAscending[index];
}

/**
 * P1 and P99 of the per-pixel relative luminance of RGBA pixel data. Fully transparent pixels
 * are ignored. Returns null when no pixel is visible.
 */
export function measureLuminance(rgba: ArrayLike<number>): SkinLuminance | null {
  const pixelCount = Math.floor(rgba.length / 4);
  const values = new Float64Array(pixelCount);
  let visible = 0;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const offset = pixel * 4;
    if (rgba[offset + 3] === 0) continue;
    values[visible] = relativeLuminance(rgba[offset], rgba[offset + 1], rgba[offset + 2]);
    visible += 1;
  }
  if (visible === 0) return null;
  const sorted = values.subarray(0, visible).sort();
  return { low: percentile(sorted, 0.01), high: percentile(sorted, 0.99) };
}
