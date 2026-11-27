import type { NoteLocalReminder } from "@getpaseo/protocol/notes/schemas";
import type { Note } from "./model";

// Web and desktop have no scheduled local notifications: the daemon alerts them when a time
// note fires. Only phones hold a local reminder (see local-reminders.native.ts).

export async function claimLocalReminder(_at: string): Promise<NoteLocalReminder | null> {
  return null;
}

export async function syncNoteLocalReminder(_serverId: string, _note: Note): Promise<void> {}

export async function cancelNoteLocalReminder(_serverId: string, _noteId: string): Promise<void> {}

export interface ScheduledNoteReminder {
  serverId: string;
  noteId: string;
}

export async function listScheduledNoteReminders(): Promise<ScheduledNoteReminder[]> {
  return [];
}
