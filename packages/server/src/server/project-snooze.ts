/**
 * Snooze: the user puts a project away until a set time. While snoozed its chats send no
 * attention alerts (push or in-app); the app folds it into "More". It wakes by itself once the
 * time passes: nothing clears the stored value, every reader compares it with now.
 */

/**
 * The value to store for a requested snooze. Null wakes the project; a time already past wakes it
 * too. Returns `undefined` for a value that is not a time.
 */
export function normalizeSnoozedUntil(
  value: string | null,
  nowMs: number,
): string | null | undefined {
  if (value === null) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return undefined;
  return ms > nowMs ? new Date(ms).toISOString() : null;
}

export function isSnoozed(snoozedUntil: string | null | undefined, nowMs: number): boolean {
  if (!snoozedUntil) return false;
  const ms = Date.parse(snoozedUntil);
  return !Number.isNaN(ms) && ms > nowMs;
}

/**
 * The descriptor field for a project record. A project never snoozed has no field, so older
 * descriptors stay byte-identical; one snoozed before always sends it, null once woken, so a
 * client that merges descriptors still sees the wake.
 */
export function projectSnoozeField(record: { snoozedUntil?: string | null } | null | undefined): {
  projectSnoozedUntil?: string | null;
} {
  if (!record || record.snoozedUntil === undefined) return {};
  return { projectSnoozedUntil: record.snoozedUntil };
}
