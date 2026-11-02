/**
 * Reads the free-text time of a "waiting on a time" note: clock times (`3pm`, `15:30`, `at 3pm`),
 * relative times (`in 2 hours`, `in 45m`, `in 1h 30m`) and day-qualified clock times
 * (`tomorrow 9am`, `today at 17:00`). A clock time without a day that already passed today means
 * the same time tomorrow. Returns null for anything it cannot read, and for times not in the future.
 */

export type ReminderPreset = "in30m" | "in1h" | "in2h" | "tomorrow9";

export const REMINDER_PRESETS: readonly ReminderPreset[] = ["in30m", "in1h", "in2h", "tomorrow9"];

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_TOMORROW_HOUR = 9;

export function resolveReminderPreset(preset: ReminderPreset, now: Date): Date {
  switch (preset) {
    case "in30m":
      return new Date(now.getTime() + 30 * MINUTE_MS);
    case "in1h":
      return new Date(now.getTime() + HOUR_MS);
    case "in2h":
      return new Date(now.getTime() + 2 * HOUR_MS);
    case "tomorrow9":
      return atClock(now, 1, DEFAULT_TOMORROW_HOUR, 0);
  }
}

export function parseReminderTime(input: string, now: Date): Date | null {
  const text = input
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!]+$/, "");
  if (!text) return null;

  const relative = parseRelative(text);
  if (relative !== null) {
    return relative > 0 ? new Date(now.getTime() + relative) : null;
  }

  const { day, rest } = splitDay(text);
  const clockText = rest.replace(/^(?:at|@)\s*/, "");
  if (!clockText) {
    return day === "tomorrow" ? atClock(now, 1, DEFAULT_TOMORROW_HOUR, 0) : null;
  }
  // A bare number (`15`) is only an hour when a day or `at` says it is a time of day.
  const clock = parseClock(clockText, day !== null || clockText !== rest);
  if (!clock) return null;

  if (day === "tomorrow") return atClock(now, 1, clock.hour, clock.minute);
  const today = atClock(now, 0, clock.hour, clock.minute);
  if (today.getTime() > now.getTime()) return today;
  if (day === "today") return null;
  return atClock(now, 1, clock.hour, clock.minute);
}

const DAY_WORDS: Record<string, "today" | "tomorrow"> = {
  today: "today",
  tonight: "today",
  tomorrow: "tomorrow",
  tmrw: "tomorrow",
  tmr: "tomorrow",
};

function splitDay(text: string): { day: "today" | "tomorrow" | null; rest: string } {
  const leading = /^(today|tonight|tomorrow|tmrw|tmr)\b\s*(.*)$/.exec(text);
  if (leading) return { day: DAY_WORDS[leading[1]], rest: leading[2] };
  const trailing = /^(.*?)\s*\b(today|tonight|tomorrow|tmrw|tmr)$/.exec(text);
  if (trailing) return { day: DAY_WORDS[trailing[2]], rest: trailing[1] };
  return { day: null, rest: text };
}

const UNIT_MS: Record<string, number> = {
  m: MINUTE_MS,
  min: MINUTE_MS,
  mins: MINUTE_MS,
  minute: MINUTE_MS,
  minutes: MINUTE_MS,
  h: HOUR_MS,
  hr: HOUR_MS,
  hrs: HOUR_MS,
  hour: HOUR_MS,
  hours: HOUR_MS,
  d: DAY_MS,
  day: DAY_MS,
  days: DAY_MS,
};

const DURATION_PART =
  /(?:(\d+(?:\.\d+)?)\s*|(an?)\s+)(minutes?|mins?|m|hours?|hrs?|hr|h|days?|d)(?![a-z])/y;
const DURATION_SEPARATOR = /\s*(?:and\s+|,\s*)?/y;

/** Milliseconds for `in 2 hours`, `45m`, `in 1h 30m`, `in half an hour`; null when not relative. */
function parseRelative(text: string): number | null {
  const body = text.replace(/^in\s+/, "");
  if (body === "half an hour" || body === "half hour") return 30 * MINUTE_MS;

  let total = 0;
  let index = 0;
  while (index < body.length) {
    DURATION_PART.lastIndex = index;
    const part = DURATION_PART.exec(body);
    if (!part) return null;
    const amount = part[2] ? 1 : Number(part[1]);
    total += amount * UNIT_MS[part[3]];
    DURATION_SEPARATOR.lastIndex = DURATION_PART.lastIndex;
    DURATION_SEPARATOR.exec(body);
    index = DURATION_SEPARATOR.lastIndex;
  }
  return index > 0 ? Math.round(total) : null;
}

function parseClock(text: string, allowBareHour: boolean): { hour: number; minute: number } | null {
  if (text === "noon" || text === "midday") return { hour: 12, minute: 0 };
  if (text === "midnight") return { hour: 0, minute: 0 };

  const match = /^(\d{1,2})(?:[:.h](\d{2}))?\s*(a\.?m\.?|p\.?m\.?|a|p)?$/.exec(text);
  if (!match) return null;
  const rawHour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  if (minute > 59) return null;

  const meridiem = match[3]?.[0];
  if (meridiem) {
    if (rawHour < 1 || rawHour > 12) return null;
    return { hour: (rawHour % 12) + (meridiem === "p" ? 12 : 0), minute };
  }
  if (match[2] === undefined && !allowBareHour) return null;
  if (rawHour > 23) return null;
  return { hour: rawHour, minute };
}

/** Local wall-clock time `dayOffset` days after `now`'s date; DST-safe because it builds by fields. */
function atClock(now: Date, dayOffset: number, hour: number, minute: number): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, hour, minute, 0, 0);
}
