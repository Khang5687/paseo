import type { FileDevice } from "@getpaseo/client/internal/daemon-client";

/** The devices a file can go to: every registered device except the one holding the menu. */
export function listSendTargets(devices: readonly FileDevice[], ownDeviceId: string) {
  return devices
    .filter((device) => device.deviceId !== ownDeviceId)
    .toSorted((a, b) => Number(b.reachable) - Number(a.reachable) || a.name.localeCompare(b.name));
}

export function fileNameOf(path: string): string {
  return path.split(/[\\/]/).findLast((segment) => segment.length > 0) ?? path;
}
