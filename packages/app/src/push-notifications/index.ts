import type { RevokePushNotificationsInput, StartPushNotificationsInput } from "./internal/types";

export function startPushNotifications(_input: StartPushNotificationsInput): () => void {
  return () => undefined;
}

export async function revokePushNotifications(_input: RevokePushNotificationsInput): Promise<void> {
  // Push notifications are native-only.
}

/** The push token this device uses with a host; web and desktop have none. */
export async function getPushToken(_serverId: string): Promise<string | null> {
  return null;
}
