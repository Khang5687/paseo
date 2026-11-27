import type { WorkspaceStructureHostPlacement } from "@/projects/workspace-structure";

/** A snoozed project comes back at this local hour on the day you pick. */
export const SNOOZE_WAKE_HOUR = 8;

type SnoozeHosts = readonly Pick<WorkspaceStructureHostPlacement, "snoozedUntil">[];

/**
 * When a project comes back, in epoch ms, or null when it is awake. A project shown once for
 * several hosts is snoozed while any of its hosts still is; Snooze sets every host the same.
 */
export function projectSnoozedUntilMs(hosts: SnoozeHosts, now: number): number | null {
  let until: number | null = null;
  for (const host of hosts) {
    if (!host.snoozedUntil) continue;
    const ms = Date.parse(host.snoozedUntil);
    if (Number.isNaN(ms) || ms <= now) continue;
    until = until === null ? ms : Math.max(until, ms);
  }
  return until;
}

export function resolveSnoozedProjectKeys(
  projects: readonly { viewKey: string; hosts: SnoozeHosts }[],
  now: number,
): Set<string> {
  const keys = new Set<string>();
  for (const project of projects) {
    if (projectSnoozedUntilMs(project.hosts, now) !== null) keys.add(project.viewKey);
  }
  return keys;
}

/** The soonest time a snoozed project wakes, so the sidebar can redraw right then. */
export function nextSnoozeWakeMs(
  projects: readonly { hosts: SnoozeHosts }[],
  now: number,
): number | null {
  let next: number | null = null;
  for (const project of projects) {
    const until = projectSnoozedUntilMs(project.hosts, now);
    if (until !== null && (next === null || until < next)) next = until;
  }
  return next;
}

function atWakeHour(day: Date): Date {
  const wake = new Date(day);
  wake.setHours(SNOOZE_WAKE_HOUR, 0, 0, 0);
  return wake;
}

/** Tomorrow at the wake hour, local time. */
export function snoozeUntilTomorrow(now: Date): Date {
  const day = new Date(now);
  day.setDate(day.getDate() + 1);
  return atWakeHour(day);
}

/** The next Monday at the wake hour; on a Monday that is a week away. */
export function snoozeUntilMonday(now: Date): Date {
  const day = new Date(now);
  const daysAhead = (8 - day.getDay()) % 7 || 7;
  day.setDate(day.getDate() + daysAhead);
  return atWakeHour(day);
}

/** A picked calendar day (`YYYY-MM-DD`) at the wake hour, or null when it is not after now. */
export function snoozeUntilDate(isoDay: string, now: Date): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDay);
  if (!match) return null;
  const wake = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(wake.getTime())) return null;
  const at = atWakeHour(wake);
  return at.getTime() > now.getTime() ? at : null;
}
