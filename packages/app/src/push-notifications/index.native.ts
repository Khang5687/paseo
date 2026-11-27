import { resolveToken, revokeSubscription, startSubscription } from "./internal/subscriptions";
import type { RevokePushNotificationsInput, StartPushNotificationsInput } from "./internal/types";

export function startPushNotifications(input: StartPushNotificationsInput): () => void {
  return startSubscription(input);
}

export function revokePushNotifications(input: RevokePushNotificationsInput): Promise<void> {
  return revokeSubscription(input).catch((error) => {
    console.warn("[PushNotifications] Failed to remove local push subscription", error);
  });
}

export function getPushToken(serverId: string): Promise<string | null> {
  return resolveToken(serverId).catch(() => null);
}
