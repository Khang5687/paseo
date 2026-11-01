import * as Notifications from "expo-notifications";
import type { NoteLocalReminder } from "@getpaseo/protocol/notes/schemas";
import { i18n } from "@/i18n/i18next";
import {
  DEFAULT_NOTIFICATION_CHANNEL_ID,
  ensureDefaultNotificationChannel,
  ensureNotificationPermission,
} from "@/push-notifications/native-notifications";
import { getOrCreateClientId } from "@/utils/client-id";
import { noteState, type Note } from "./model";
import { noteAlertText, noteNotificationData } from "./notification";
import { isLocalReminderId, localReminderId } from "./local-reminder-id";

/**
 * A time note's reminder, scheduled on the phone itself so it fires on time even when no daemon
 * can reach the phone. The note records `localReminder: {deviceId, at}`; the daemon then resolves
 * the note at that time without pushing, so the owner gets exactly one alert.
 */
export async function claimLocalReminder(at: string): Promise<NoteLocalReminder | null> {
  const time = Date.parse(at);
  if (!Number.isFinite(time) || time <= Date.now()) return null;
  if (!(await ensureNotificationPermission())) return null;
  return { deviceId: await getOrCreateClientId(), at };
}

/** The time this device should alert for the note, or null when it holds no reminder for it. */
async function heldReminderTime(note: Note): Promise<number | null> {
  const wait = note.wait;
  const reminder = note.localReminder;
  if (noteState(note) !== "waiting" || wait?.type !== "time" || !reminder) return null;
  if (reminder.at !== wait.at) return null;
  if (reminder.deviceId !== (await getOrCreateClientId())) return null;
  const time = Date.parse(wait.at);
  return Number.isFinite(time) && time > Date.now() ? time : null;
}

// What this process has scheduled per identifier, so repeated syncs of an unchanged note do not
// reschedule. Empty after a restart: the first sync reschedules, which replaces the same id.
const scheduledTimes = new Map<string, string>();
const queues = new Map<string, Promise<void>>();

async function apply(serverId: string, note: Note): Promise<void> {
  const identifier = localReminderId(serverId, note.id);
  const time = await heldReminderTime(note);
  if (time === null) {
    scheduledTimes.delete(identifier);
    await Notifications.cancelScheduledNotificationAsync(identifier);
    return;
  }
  const key = `${time}\n${note.text}\n${note.quote}`;
  if (scheduledTimes.get(identifier) === key) return;
  const permission = await Notifications.getPermissionsAsync();
  if (permission.status !== Notifications.PermissionStatus.GRANTED) return;
  await ensureDefaultNotificationChannel();
  await Notifications.scheduleNotificationAsync({
    identifier,
    content: {
      title: i18n.t("notes.alerts.reminderTitle", { text: noteAlertText(note) }),
      body: i18n.t("notes.alerts.reminderBody"),
      data: noteNotificationData(serverId, note),
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date: time,
      channelId: DEFAULT_NOTIFICATION_CHANNEL_ID,
    },
  });
  scheduledTimes.set(identifier, key);
}

/** Schedule this device's reminder for the note, or cancel it when the note no longer wants it. */
export function syncNoteLocalReminder(serverId: string, note: Note): Promise<void> {
  const identifier = localReminderId(serverId, note.id);
  const previous = queues.get(identifier) ?? Promise.resolve();
  const next = previous
    .then(() => apply(serverId, note))
    .catch((error) => {
      console.warn("[NoteReminders] Failed to sync local reminder", error);
    })
    .finally(() => {
      if (queues.get(identifier) === next) queues.delete(identifier);
    });
  queues.set(identifier, next);
  return next;
}

/** Cancel this device's reminder for a note that no longer exists. */
export function cancelNoteLocalReminder(serverId: string, noteId: string): Promise<void> {
  const identifier = localReminderId(serverId, noteId);
  const previous = queues.get(identifier) ?? Promise.resolve();
  const next = previous
    .then(() => {
      scheduledTimes.delete(identifier);
      return Notifications.cancelScheduledNotificationAsync(identifier);
    })
    .catch((error) => {
      console.warn("[NoteReminders] Failed to cancel local reminder", error);
    })
    .finally(() => {
      if (queues.get(identifier) === next) queues.delete(identifier);
    });
  queues.set(identifier, next);
  return next;
}

export interface ScheduledNoteReminder {
  serverId: string;
  noteId: string;
}

/** The note reminders currently scheduled on this device. */
export async function listScheduledNoteReminders(): Promise<ScheduledNoteReminder[]> {
  const requests = await Notifications.getAllScheduledNotificationsAsync();
  const reminders: ScheduledNoteReminder[] = [];
  for (const request of requests) {
    if (!isLocalReminderId(request.identifier)) continue;
    const data: unknown = request.content.data;
    if (typeof data !== "object" || data === null) continue;
    const serverId: unknown = Reflect.get(data, "serverId");
    const noteId: unknown = Reflect.get(data, "noteId");
    if (typeof serverId !== "string" || typeof noteId !== "string") continue;
    reminders.push({ serverId, noteId });
  }
  return reminders;
}
