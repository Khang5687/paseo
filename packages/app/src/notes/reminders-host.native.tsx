import { useEffect, useMemo, useState } from "react";
import { useAppVisible } from "@/hooks/use-app-visible";
import {
  cancelNoteLocalReminder,
  listScheduledNoteReminders,
  syncNoteLocalReminder,
  type ScheduledNoteReminder,
} from "./local-reminders";
import { useNotesDemand, useNotesStore, type NotesHostSnapshot } from "./store";

function reconcile(host: NotesHostSnapshot, scheduled: readonly ScheduledNoteReminder[]): void {
  for (const note of host.notes) void syncNoteLocalReminder(host.serverId, note);
  if (host.status !== "online") return;
  const present = new Set(host.notes.map((note) => note.id));
  for (const reminder of scheduled) {
    if (reminder.serverId === host.serverId && !present.has(reminder.noteId)) {
      void cancelNoteLocalReminder(reminder.serverId, reminder.noteId);
    }
  }
}

/**
 * Keeps this phone's scheduled note reminders in step with their notes while the app is in the
 * foreground: a note resolved, deleted, re-timed, or claimed by another device cancels or
 * reschedules its reminder. Driven by the notes subscriptions, never by polling.
 */
export function NoteRemindersHost() {
  const active = useAppVisible();
  const [scheduled, setScheduled] = useState<ScheduledNoteReminder[]>([]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void (async () => {
      try {
        const reminders = await listScheduledNoteReminders();
        if (!cancelled) setScheduled(reminders);
      } catch (error) {
        console.warn("[NoteReminders] Failed to list reminders", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active]);

  const serverIds = useMemo(
    () => (active ? [...new Set(scheduled.map((reminder) => reminder.serverId))].sort() : []),
    [active, scheduled],
  );
  useNotesDemand(serverIds);

  useEffect(() => {
    if (!active) return;
    const hosts = useNotesStore.getState().hosts;
    for (const host of Object.values(hosts)) reconcile(host, scheduled);
    return useNotesStore.subscribe((state, previous) => {
      for (const host of Object.values(state.hosts)) {
        if (previous.hosts[host.serverId] !== host) reconcile(host, scheduled);
      }
    });
  }, [active, scheduled]);

  return null;
}
