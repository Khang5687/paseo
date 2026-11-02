import type { Note } from "./model";

const TITLE_LIMIT = 120;

/** The note's text as the daemon's "Done: <note>" alert shows it (whitespace folded, clipped). */
export function noteAlertText(note: Note): string {
  const text = (note.text || note.quote).replace(/\s+/g, " ").trim();
  return text.length <= TITLE_LIMIT ? text : `${text.slice(0, TITLE_LIMIT - 1).trimEnd()}…`;
}

/**
 * Notification data for a note, in the daemon push's shape: tapping any note alert (push, local
 * reminder, desktop notification) opens the same spot.
 */
export function noteNotificationData(serverId: string, note: Note): Record<string, string> {
  const { anchor } = note;
  const data: Record<string, string> = { serverId, noteId: note.id };
  if (anchor.workspaceId) data.workspaceId = anchor.workspaceId;
  if (anchor.kind === "agent") {
    data.agentId = anchor.agentId;
    return data;
  }
  data.terminalId = anchor.terminalId;
  if (anchor.cwd) data.cwd = anchor.cwd;
  return data;
}
