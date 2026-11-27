import type pino from "pino";
import { readFile } from "node:fs/promises";
import { z } from "zod";

import { ensurePrivateFile, writePrivateFileAtomicSync } from "../private-files.js";

// A device that has not connected for this long is forgotten.
const DEVICE_FORGET_MS = 90 * 24 * 60 * 60 * 1000;

const StoredDeviceSchema = z.object({
  deviceId: z.string().min(1),
  name: z.string(),
  kind: z.string(),
  pushToken: z.string().optional(),
  lastSeenAt: z.string(),
});
const StoredFileSchema = z.object({ devices: z.array(z.unknown()) });

export interface FileDeviceRecord {
  deviceId: string;
  name: string;
  kind: string;
  /** Where a push for this device goes. Phones only. */
  pushToken: string | null;
  lastSeenAt: number;
}

/**
 * The devices that told this host what they are called: a phone with its push token, a desktop
 * or browser app by name. Apps register on every connect, so `lastSeenAt` is the last connect.
 * The push token store keeps its own lease for broadcast pushes; this registry does not, because
 * a file sent to a phone must reach it even after days away.
 */
export class FileDeviceRegistry {
  private devices = new Map<string, FileDeviceRecord>();
  private constructor(
    private readonly filePath: string | null,
    private readonly now: () => number,
    stored: readonly unknown[],
  ) {
    this.restore(stored);
  }

  /** Loads the devices saved at `filePath`; a missing or damaged file starts empty. */
  static async open(
    logger: pino.Logger,
    filePath: string,
    now: () => number = Date.now,
  ): Promise<FileDeviceRegistry> {
    let stored: readonly unknown[] = [];
    try {
      ensurePrivateFile(filePath);
      stored = StoredFileSchema.parse(JSON.parse(await readFile(filePath, "utf-8"))).devices;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.warn({ err }, "Failed to load file devices");
      }
    }
    return new FileDeviceRegistry(filePath, now, stored);
  }

  /** A registry that forgets on restart: for hosts built without a home folder, and tests. */
  static inMemory(now: () => number = Date.now): FileDeviceRegistry {
    return new FileDeviceRegistry(null, now, []);
  }

  register(input: {
    deviceId: string;
    name: string;
    kind: string;
    pushToken?: string | null;
  }): void {
    const next = new Map(this.devices);
    const pushToken = input.pushToken?.trim() || null;
    // A token belongs to one device; a reinstall gets a new client id and the same token.
    if (pushToken) {
      for (const [id, record] of next) {
        if (id !== input.deviceId && record.pushToken === pushToken) next.delete(id);
      }
    }
    next.set(input.deviceId, {
      deviceId: input.deviceId,
      name: input.name.trim() || input.kind,
      kind: input.kind,
      pushToken,
      lastSeenAt: this.now(),
    });
    this.persist(next);
    this.devices = next;
  }

  /** The phone signed out of push, or the push service said the token is dead. */
  removeByToken(token: string): void {
    const normalized = token.trim();
    const next = new Map(this.devices);
    for (const [id, record] of next) {
      if (record.pushToken === normalized) next.delete(id);
    }
    if (next.size === this.devices.size) return;
    this.persist(next);
    this.devices = next;
  }

  get(deviceId: string): FileDeviceRecord | null {
    return this.devices.get(deviceId) ?? null;
  }

  list(): FileDeviceRecord[] {
    return [...this.devices.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  private restore(stored: readonly unknown[]): void {
    const cutoff = this.now() - DEVICE_FORGET_MS;
    for (const value of stored) {
      const parsed = StoredDeviceSchema.safeParse(value);
      if (!parsed.success) continue;
      const lastSeenAt = Date.parse(parsed.data.lastSeenAt);
      if (!Number.isFinite(lastSeenAt) || lastSeenAt < cutoff) continue;
      this.devices.set(parsed.data.deviceId, {
        deviceId: parsed.data.deviceId,
        name: parsed.data.name,
        kind: parsed.data.kind,
        pushToken: parsed.data.pushToken ?? null,
        lastSeenAt,
      });
    }
  }

  private persist(devices: ReadonlyMap<string, FileDeviceRecord>): void {
    if (!this.filePath) return;
    const payload =
      JSON.stringify(
        {
          devices: Array.from(devices.values(), (record) => ({
            deviceId: record.deviceId,
            name: record.name,
            kind: record.kind,
            ...(record.pushToken ? { pushToken: record.pushToken } : {}),
            lastSeenAt: new Date(record.lastSeenAt).toISOString(),
          })),
        },
        null,
        2,
      ) + "\n";
    writePrivateFileAtomicSync(this.filePath, payload);
  }
}
