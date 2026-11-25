import { getIsElectron } from "@/constants/platform";

export interface FileDeviceIdentity {
  /** `phone` (a mobile app, reached by push), `desktop` or `web`. */
  kind: "phone" | "desktop" | "web";
  name: string;
}

function desktopName(): string {
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  if (/mac/i.test(platform)) return "Mac app";
  if (/win/i.test(platform)) return "Windows app";
  if (/linux/i.test(platform)) return "Linux app";
  return "Desktop app";
}

/** What this device calls itself in another host's "Send to" list. Web and desktop. */
export function getFileDeviceIdentity(): FileDeviceIdentity {
  return getIsElectron()
    ? { kind: "desktop", name: desktopName() }
    : { kind: "web", name: "Web browser" };
}
