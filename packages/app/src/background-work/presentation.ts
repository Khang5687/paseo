import type { AgentBackgroundWorkSummary } from "@getpaseo/protocol/messages";
import { i18n } from "@/i18n/i18next";
import { formatResetTime } from "@/usage/format";

export function backgroundWorkText(
  item: { description: string | null; command?: string },
  kind: string,
): { title: string; command: string | null } {
  const title = item.description ?? item.command ?? kind;
  return { title, command: item.command && item.command !== title ? item.command : null };
}

/** "next Sat 09:00": a clock time today, a weekday this week, a date after that. */
export function formatNextRunLabel(iso: string, now = Date.now()): string {
  const time = formatResetTime(iso, now);
  return time
    ? i18n.t("message.backgroundWork.nextRun", { time })
    : i18n.t("message.backgroundWork.nextRunDue");
}

/** How much of a job's name fits in a one-line pill or footer; their panels carry all of it. */
export const WAITING_SHORT_TITLE_CHARS = 32;

/**
 * "Waiting: fork build". A provider that names no job still gets a noun, never a bare word.
 * `maxChars` cuts a long command for places that cannot ellipsize it themselves.
 */
export function formatWaitingLabel(title: string, maxChars?: number): string {
  const job =
    maxChars !== undefined && title.length > maxChars ? `${title.slice(0, maxChars - 1)}…` : title;
  return i18n.t("message.backgroundWork.waitingOn", {
    job: job || i18n.t("message.backgroundWork.unnamedJob"),
  });
}

export interface BackgroundWorkTally {
  /** Work that is doing something now: shells, monitors, daemon watches. */
  running: number;
  /** Work that waits for a time (heartbeats). It never shows the running ring. */
  scheduled: number;
  /** The earliest scheduled run, when there is scheduled work. */
  nextRunAt: string | null;
}

/**
 * Splits an agent's background work into what runs now and what waits for a time. The live list
 * decides once it has loaded; until then the agent summary stands in, which cannot tell scheduled
 * work from other idle daemon work, so it only calls work scheduled when it names a next run.
 */
export function tallyBackgroundWork(
  items: readonly { nextRunAt?: string }[] | null,
  summary: AgentBackgroundWorkSummary,
): BackgroundWorkTally {
  if (items) {
    let nextRunAt: string | null = null;
    let scheduled = 0;
    for (const item of items) {
      if (!item.nextRunAt) continue;
      scheduled++;
      if (!nextRunAt || Date.parse(item.nextRunAt) < Date.parse(nextRunAt)) {
        nextRunAt = item.nextRunAt;
      }
    }
    return { running: items.length - scheduled, scheduled, nextRunAt };
  }
  const running = summary.runningCount ?? summary.count;
  if (!summary.nextRunAt) return { running: summary.count, scheduled: 0, nextRunAt: null };
  return { running, scheduled: summary.count - running, nextRunAt: summary.nextRunAt };
}
