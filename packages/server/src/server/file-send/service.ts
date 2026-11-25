import { promises as fs } from "node:fs";
import path from "node:path";
import type pino from "pino";
import type { SessionOutboundMessage } from "../messages.js";
import type { PushPayload } from "../push/index.js";
import type { FileDeviceRecord, FileDeviceRegistry } from "./device-registry.js";

/** A connection of the target device that can receive the `files.sent` event. */
export interface FileSendLiveTarget {
  /** The app is in the foreground. A visible phone shows the note itself instead of a push. */
  appVisible: boolean;
  publish(message: SessionOutboundMessage): void;
}

export interface FileSendDeps {
  registry: FileDeviceRegistry;
  serverId: string;
  hostName: () => string;
  sendPush: (tokens: string[], payload: PushPayload) => Promise<void>;
  liveTargets: (deviceId: string) => FileSendLiveTarget[];
  logger: pino.Logger;
}

export interface FileSendDevice {
  deviceId: string;
  name: string;
  kind: string;
  reachable: boolean;
  lastSeenAt: string;
}

export interface FileSendResult {
  deviceName: string;
  delivery: "push" | "live";
}

/** The request cannot be done; the message says why and is safe to show the user or an agent. */
export class FileSendError extends Error {}

export function sentFilePushPayload(input: {
  serverId: string;
  hostName: string;
  path: string;
}): PushPayload {
  const fileName = path.basename(input.path);
  return {
    title: `${fileName} is ready`,
    body: `From ${input.hostName} · tap to open`,
    // Read by the app's notification router (notification-open): serverId names the host,
    // sentFilePath the file on it. The bytes are fetched when the phone opens the note.
    data: { serverId: input.serverId, sentFilePath: input.path },
  };
}

/** Tells one of the user's devices that a file on this host is ready for it. */
export class FileSendService {
  constructor(private readonly deps: FileSendDeps) {}

  listDevices(): FileSendDevice[] {
    return this.deps.registry.list().map((record) => this.describe(record));
  }

  async send(input: { deviceId: string; path: string }): Promise<FileSendResult> {
    const device = this.deps.registry.get(input.deviceId);
    if (!device) throw new FileSendError("Unknown device. Pick one from the device list.");
    if (!path.isAbsolute(input.path)) {
      throw new FileSendError(`${input.path} is not an absolute path.`);
    }
    const stat = await fs.stat(input.path).catch(() => null);
    if (!stat?.isFile()) throw new FileSendError(`${input.path} is not a file on this host.`);

    const payload = sentFilePushPayload({
      serverId: this.deps.serverId,
      hostName: this.deps.hostName(),
      path: input.path,
    });
    const live = this.deps.liveTargets(device.deviceId);
    const phone = device.kind === "phone";
    // A phone with its app open gets the note in the app as well: a foreground push shows no
    // banner, so the app shows its own. Everything else reaches a desktop or browser app.
    const liveTargets = phone ? live.filter((target) => target.appVisible) : live;
    const message: SessionOutboundMessage = {
      type: "files.sent",
      payload: {
        serverId: this.deps.serverId,
        path: input.path,
        fileName: path.basename(input.path),
        title: payload.title,
        body: payload.body,
      },
    };
    let delivery: FileSendResult["delivery"] | null = null;
    if (phone && device.pushToken) {
      await this.deps.sendPush([device.pushToken], payload);
      delivery = "push";
    }
    for (const target of liveTargets) target.publish(message);
    if (liveTargets.length > 0) delivery ??= "live";
    if (delivery) return { deviceName: device.name, delivery };
    throw new FileSendError(
      phone
        ? `${device.name} has no push token on this host. Open Paseo on it, then try again.`
        : `${device.name} is not connected. Open Paseo on it, then try again.`,
    );
  }

  private describe(record: FileDeviceRecord): FileSendDevice {
    const live = this.deps.liveTargets(record.deviceId).length > 0;
    return {
      deviceId: record.deviceId,
      name: record.name,
      kind: record.kind,
      reachable: live || (record.kind === "phone" && record.pushToken !== null),
      lastSeenAt: new Date(record.lastSeenAt).toISOString(),
    };
  }
}

/**
 * Picks the device an agent means. Without a name, the one reachable phone; with several the
 * agent must ask the user by name. A name matches a device name exactly, else as a unique
 * substring (case-insensitive), else a kind ("phone").
 */
export function pickSendTarget(devices: FileSendDevice[], wanted?: string): FileSendDevice {
  const list = (items: FileSendDevice[]) => items.map((device) => `"${device.name}"`).join(", ");
  const query = wanted?.trim().toLowerCase();
  if (!query) {
    const phones = devices.filter((device) => device.kind === "phone" && device.reachable);
    if (phones.length === 1) return phones[0];
    if (phones.length === 0) {
      throw new FileSendError(
        devices.length === 0
          ? "No device has registered with this host. Open Paseo on the target device first."
          : `No phone can be reached. Name a device: ${list(devices)}.`,
      );
    }
    throw new FileSendError(`Several phones are registered. Ask the user which: ${list(phones)}.`);
  }
  const exact = devices.filter((device) => device.name.toLowerCase() === query);
  if (exact.length === 1) return exact[0];
  const partial = devices.filter(
    (device) => device.name.toLowerCase().includes(query) || device.kind === query,
  );
  const matches = exact.length > 1 ? exact : partial;
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    throw new FileSendError(`No device matches "${wanted}". Known devices: ${list(devices)}.`);
  }
  throw new FileSendError(
    `"${wanted}" matches several devices: ${list(matches)}. Use a full name.`,
  );
}
