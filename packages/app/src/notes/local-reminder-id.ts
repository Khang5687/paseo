export const LOCAL_REMINDER_ID_PREFIX = "note:";

/** The scheduled-notification identifier of a phone's reminder for one note (one per note). */
export function localReminderId(serverId: string, noteId: string): string {
  return `${LOCAL_REMINDER_ID_PREFIX}${serverId}:${noteId}`;
}

export function isLocalReminderId(identifier: string): boolean {
  return identifier.startsWith(LOCAL_REMINDER_ID_PREFIX);
}
