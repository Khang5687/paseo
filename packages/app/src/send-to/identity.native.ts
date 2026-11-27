import Constants from "expo-constants";
import { Platform } from "react-native";
import type { FileDeviceIdentity } from "./identity";

const BASE_APP_NAME = "Paseo";

/** What this device calls itself in another host's "Send to" list. Native apps. */
export function getFileDeviceIdentity(): FileDeviceIdentity {
  const device =
    Constants.deviceName?.trim() || (Platform.OS === "ios" ? "iPhone" : "Android phone");
  const app = Constants.expoConfig?.name?.trim();
  // A debug build can sit beside the store app on one phone; the variant tells them apart.
  return {
    kind: "phone",
    name: app && app !== BASE_APP_NAME ? `${device} (${app})` : device,
  };
}
