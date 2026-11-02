import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

/** The Android channel every Paseo alert uses: daemon pushes and phone-scheduled reminders. */
export const DEFAULT_NOTIFICATION_CHANNEL_ID = "default";

export async function ensureNotificationPermission(): Promise<boolean> {
  const existing = await Notifications.getPermissionsAsync();
  if (existing.status === Notifications.PermissionStatus.GRANTED) return true;
  if (!existing.canAskAgain) return false;
  const requested = await Notifications.requestPermissionsAsync();
  return requested.status === Notifications.PermissionStatus.GRANTED;
}

export async function ensureDefaultNotificationChannel(): Promise<void> {
  if (Platform.OS !== "android") return;
  await Notifications.setNotificationChannelAsync(DEFAULT_NOTIFICATION_CHANNEL_ID, {
    name: DEFAULT_NOTIFICATION_CHANNEL_ID,
    importance: Notifications.AndroidImportance.DEFAULT,
  });
}
