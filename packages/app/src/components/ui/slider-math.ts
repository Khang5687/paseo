// Pure slider math. Every function is a worklet so the drag runs it on the UI thread.

export interface SliderRange {
  min: number;
  max: number;
  step: number;
}

function stepDecimals(step: number): number {
  "worklet";
  const text = `${step}`;
  const dot = text.indexOf(".");
  return dot === -1 ? 0 : text.length - dot - 1;
}

/** Clamps into the range and rounds to the nearest step, measured from `min`. */
export function snapSliderValue(value: number, range: SliderRange): number {
  "worklet";
  const { min, max, step } = range;
  if (!(max > min)) return min;
  const clamped = Math.min(max, Math.max(min, value));
  if (!(step > 0)) return clamped;
  const snapped = min + Math.round((clamped - min) / step) * step;
  // Float steps (0.1) accumulate error; round back to the step's own precision.
  return Math.min(max, Number(snapped.toFixed(stepDecimals(step))));
}

/** Where a value sits along the track, 0 at `min` and 1 at `max`. */
export function sliderFraction(value: number, range: SliderRange): number {
  "worklet";
  const { min, max } = range;
  if (!(max > min)) return 0;
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

/**
 * The value under a touch. `x` is measured from the hit area's left edge; the thumb's center
 * travels from `inset` to `width - inset`, so a touch on the thumb's outer half still lands on
 * the end value.
 */
export function sliderValueAtPosition(
  x: number,
  width: number,
  inset: number,
  range: SliderRange,
): number {
  "worklet";
  const travel = width - inset * 2;
  if (!(travel > 0)) return snapSliderValue(range.min, range);
  const fraction = Math.min(1, Math.max(0, (x - inset) / travel));
  return snapSliderValue(range.min + fraction * (range.max - range.min), range);
}

const PAGE_STEPS = 10;

/** The value a key moves to, or null when the key does not adjust a slider. */
export function sliderValueForKey(key: string, value: number, range: SliderRange): number | null {
  switch (key) {
    case "ArrowRight":
    case "ArrowUp":
      return snapSliderValue(value + range.step, range);
    case "ArrowLeft":
    case "ArrowDown":
      return snapSliderValue(value - range.step, range);
    case "PageUp":
      return snapSliderValue(value + range.step * PAGE_STEPS, range);
    case "PageDown":
      return snapSliderValue(value - range.step * PAGE_STEPS, range);
    case "Home":
      return range.min;
    case "End":
      return range.max;
    default:
      return null;
  }
}
