// The black screen runs with the phone in a pocket, so one stray touch must never wake it.
// Only two short, still taps close together in time and place count, the same shape as a
// platform double-tap (Android's DOUBLE_TAP_TIMEOUT is 300 ms from first lift to second press).

export interface WakeTapPoint {
  x: number;
  y: number;
  at: number;
}

export interface WakeTap {
  start: WakeTapPoint;
  end: WakeTapPoint;
}

const WAKE_DOUBLE_TAP_MS = 300;
const WAKE_TAP_MAX_HOLD_MS = 250;
const WAKE_TAP_MAX_SLOP = 16;
const WAKE_TAPS_MAX_APART = 48;

function distance(a: WakeTapPoint, b: WakeTapPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export interface WakeTapResult {
  wake: boolean;
  /** Pass back as `previous` with the next tap. */
  pending: WakeTap | null;
}

export function registerWakeTap(previous: WakeTap | null, tap: WakeTap): WakeTapResult {
  const isTap =
    tap.end.at - tap.start.at <= WAKE_TAP_MAX_HOLD_MS &&
    distance(tap.start, tap.end) <= WAKE_TAP_MAX_SLOP;
  if (!isTap) {
    return { wake: false, pending: null };
  }
  if (
    previous &&
    tap.start.at - previous.end.at <= WAKE_DOUBLE_TAP_MS &&
    distance(previous.end, tap.start) <= WAKE_TAPS_MAX_APART
  ) {
    return { wake: true, pending: null };
  }
  return { wake: false, pending: tap };
}
