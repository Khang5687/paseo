import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { z } from "zod";
import { readValidatedString } from "@/storage/validated-storage";
import {
  ensureDefaultNotificationChannel,
  ensureNotificationPermission,
} from "../native-notifications";

const STORAGE_PREFIX = "@paseo:expo-push-token:";
const ExpoPushTokenSchema = z.string().trim().min(1);

function storageKey(serverId: string): string {
  return `${STORAGE_PREFIX}${serverId}`;
}

function getExpoProjectId(): string | null {
  const fromEas = ExpoPushTokenSchema.safeParse(Constants.easConfig?.projectId);
  if (fromEas.success) return fromEas.data;
  const fromExtra = ExpoPushTokenSchema.safeParse(Constants.expoConfig?.extra?.eas?.projectId);
  return fromExtra.success ? fromExtra.data : null;
}

export async function readCachedExpoPushToken(serverId: string): Promise<string | null> {
  return readValidatedString(AsyncStorage, storageKey(serverId), ExpoPushTokenSchema);
}

export async function removeCachedExpoPushToken(serverId: string): Promise<void> {
  await AsyncStorage.removeItem(storageKey(serverId));
}

export async function resolveExpoPushToken(serverId: string): Promise<string | null> {
  const key = storageKey(serverId);
  const cached = await readValidatedString(AsyncStorage, key, ExpoPushTokenSchema);
  if (!(await ensureNotificationPermission())) {
    await AsyncStorage.removeItem(key);
    return null;
  }

  await ensureDefaultNotificationChannel();

  const projectId = getExpoProjectId();
  if (!projectId) {
    console.warn("[PushNotifications] Missing EAS projectId; cannot fetch Expo push token");
    return cached;
  }

  const result = await Notifications.getExpoPushTokenAsync({ projectId });
  const token = result.data.trim();
  if (!token) return cached;
  await AsyncStorage.setItem(key, token);
  return token;
}
