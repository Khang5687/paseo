import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { SessionOutboundMessage } from "../messages.js";
import type { PushPayload } from "../push/index.js";
import { FileDeviceRegistry } from "./device-registry.js";
import {
  FileSendError,
  FileSendService,
  pickSendTarget,
  type FileSendDevice,
  type FileSendLiveTarget,
} from "./service.js";

function createLogger(): pino.Logger {
  const logger = {
    child: () => logger,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  return logger as unknown as pino.Logger;
}

describe("send to device", () => {
  let home: string;
  let clip: string;
  let now: number;
  let registry: FileDeviceRegistry;
  let pushes: Array<{ tokens: string[]; payload: PushPayload }>;
  let live: Map<string, FileSendLiveTarget[]>;
  let service: FileSendService;

  const reopen = () =>
    FileDeviceRegistry.open(createLogger(), path.join(home, "devices.json"), () => now);

  beforeEach(async () => {
    home = mkdtempSync(path.join(tmpdir(), "paseo-file-send-"));
    clip = path.join(home, "clip.mp4");
    writeFileSync(clip, "bytes");
    now = Date.parse("2026-11-26T00:00:00.000Z");
    registry = await reopen();
    pushes = [];
    live = new Map();
    service = new FileSendService({
      registry,
      serverId: "omen-server",
      hostName: () => "Omen",
      sendPush: async (tokens, payload) => {
        pushes.push({ tokens, payload });
      },
      liveTargets: (deviceId) => live.get(deviceId) ?? [],
      logger: createLogger(),
    });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function target(appVisible: boolean) {
    const received: SessionOutboundMessage[] = [];
    const liveTarget: FileSendLiveTarget = {
      appVisible,
      publish: (message) => received.push(message),
    };
    return { liveTarget, received };
  }

  test("a phone gets a push that names the host and the file, and no bytes", async () => {
    registry.register({
      deviceId: "p1",
      name: "Pixel (Paseo Debug)",
      kind: "phone",
      pushToken: "ExponentPushToken[a]",
    });

    const result = await service.send({ deviceId: "p1", path: clip });

    expect(result).toEqual({ deviceName: "Pixel (Paseo Debug)", delivery: "push" });
    expect(pushes).toEqual([
      {
        tokens: ["ExponentPushToken[a]"],
        payload: {
          title: "clip.mp4 is ready",
          body: "From Omen · tap to open",
          data: { serverId: "omen-server", sentFilePath: clip },
        },
      },
    ]);
  });

  test("a phone with its app open also gets the note in the app; a backgrounded one does not", async () => {
    registry.register({ deviceId: "p1", name: "Pixel", kind: "phone", pushToken: "tok" });
    const open = target(true);
    const background = target(false);
    live.set("p1", [open.liveTarget, background.liveTarget]);

    await service.send({ deviceId: "p1", path: clip });

    expect(pushes).toHaveLength(1);
    expect(open.received).toEqual([
      {
        type: "files.sent",
        payload: {
          serverId: "omen-server",
          path: clip,
          fileName: "clip.mp4",
          title: "clip.mp4 is ready",
          body: "From Omen · tap to open",
        },
      },
    ]);
    expect(background.received).toEqual([]);
  });

  test("a desktop app is reached over its connection and is unreachable without one", async () => {
    registry.register({ deviceId: "d1", name: "Mac app", kind: "desktop" });
    await expect(service.send({ deviceId: "d1", path: clip })).rejects.toThrow(
      "Mac app is not connected",
    );
    expect(service.listDevices()).toMatchObject([{ deviceId: "d1", reachable: false }]);

    const connection = target(false);
    live.set("d1", [connection.liveTarget]);
    expect(service.listDevices()).toMatchObject([{ deviceId: "d1", reachable: true }]);
    await expect(service.send({ deviceId: "d1", path: clip })).resolves.toEqual({
      deviceName: "Mac app",
      delivery: "live",
    });
    expect(connection.received).toHaveLength(1);
    expect(pushes).toEqual([]);
  });

  test("refuses a path that is not a file on this host, and an unknown device", async () => {
    registry.register({ deviceId: "p1", name: "Pixel", kind: "phone", pushToken: "tok" });
    await expect(service.send({ deviceId: "p1", path: home })).rejects.toBeInstanceOf(
      FileSendError,
    );
    await expect(service.send({ deviceId: "p1", path: "clip.mp4" })).rejects.toThrow(
      "not an absolute path",
    );
    await expect(service.send({ deviceId: "nope", path: clip })).rejects.toThrow("Unknown device");
    expect(pushes).toEqual([]);
  });

  test("a phone keeps its push token across a restart, even after days away, until it signs out", async () => {
    registry.register({ deviceId: "p1", name: "Pixel", kind: "phone", pushToken: "tok" });
    now += 30 * 24 * 60 * 60 * 1000;
    const restarted = await reopen();
    expect(restarted.get("p1")?.pushToken).toBe("tok");

    // A reinstall gets a new client id and the same token: one device, not two.
    restarted.register({ deviceId: "p2", name: "Pixel", kind: "phone", pushToken: "tok" });
    expect(restarted.list().map((device) => device.deviceId)).toEqual(["p2"]);

    restarted.removeByToken("tok");
    expect((await reopen()).list()).toEqual([]);
  });

  test("forgets a device that has not connected for 90 days", async () => {
    registry.register({ deviceId: "p1", name: "Old phone", kind: "phone", pushToken: "tok" });
    now += 91 * 24 * 60 * 60 * 1000;
    expect((await reopen()).list()).toEqual([]);
  });
});

describe("the device an agent means", () => {
  const device = (name: string, kind: string, reachable = true): FileSendDevice => ({
    deviceId: name,
    name,
    kind,
    reachable,
    lastSeenAt: "2026-11-26T00:00:00.000Z",
  });
  const pixel = device("Pixel (Paseo Debug)", "phone");
  const ipad = device("iPad", "phone");
  const mac = device("Mac app", "desktop");

  test("no name: the one reachable phone", () => {
    expect(pickSendTarget([pixel, mac])).toBe(pixel);
    expect(pickSendTarget([pixel, device("Old phone", "phone", false)])).toBe(pixel);
  });

  test("no name with two phones, or none: an error that names them so the agent can ask", () => {
    expect(() => pickSendTarget([pixel, ipad, mac])).toThrow(
      /Ask the user which: "Pixel \(Paseo Debug\)", "iPad"/,
    );
    expect(() => pickSendTarget([mac])).toThrow(/No phone can be reached.*"Mac app"/);
    expect(() => pickSendTarget([])).toThrow("No device has registered");
  });

  test("a name matches exactly, as a unique part, or by kind", () => {
    expect(pickSendTarget([pixel, ipad, mac], "ipad")).toBe(ipad);
    expect(pickSendTarget([pixel, ipad, mac], "pixel")).toBe(pixel);
    expect(pickSendTarget([pixel, mac], "desktop")).toBe(mac);
    expect(() => pickSendTarget([pixel, ipad], "phone")).toThrow(/matches several devices/);
    expect(() => pickSendTarget([pixel], "watch")).toThrow(/No device matches "watch"/);
  });
});
