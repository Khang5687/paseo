import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DaemonClient } from "../test-utils/daemon-client.js";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import type { PushPayload } from "../push/index.js";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";

let ctx: DaemonTestContext;
let phone: DaemonClient;
let dir: string;
let clip: string;
const pushes: Array<{ tokens: string[]; payload: PushPayload }> = [];

beforeEach(async () => {
  pushes.length = 0;
  // The test sender stands in for the Expo push service: nothing leaves the machine.
  ctx = await createDaemonTestContext({
    pushNotificationSender: {
      send: async () => {},
      sendToTokens: async (tokens, payload) => {
        pushes.push({ tokens, payload });
      },
    },
  });
  phone = new DaemonClient({ url: `ws://127.0.0.1:${ctx.daemon.port}/ws` });
  await phone.connect();
  dir = mkdtempSync(path.join(tmpdir(), "daemon-send-to-"));
  clip = path.join(dir, "clip.mp4");
  writeFileSync(clip, "bytes");
});

afterEach(async () => {
  await phone.close();
  await ctx.cleanup();
  rmSync(dir, { recursive: true, force: true });
}, 60000);

async function waitFor<T>(read: () => T | undefined, timeoutMs = 10000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

function collectSent(client: DaemonClient) {
  const received: SessionOutboundMessage[] = [];
  const feed = client.observeEvents(["files.sent"], { notifications: true });
  feed.subscribe({ snapshot: () => {}, update: (message) => received.push(message) });
  return { received, ready: feed.ready };
}

test("the host advertises send to device", () => {
  expect(ctx.client.getLastServerInfoMessage()?.features?.sendToDevice).toBe(true);
});

test("a file sent to a desktop app arrives on its open connection", async () => {
  await ctx.client.registerFileDevice({ name: "Mac app", kind: "desktop" });
  const desktop = collectSent(ctx.client);
  await desktop.ready;
  await phone.registerFileDevice({
    name: "Pixel",
    kind: "phone",
    pushToken: "ExponentPushToken[p]",
  });

  const devices = await phone.listFileDevices();
  expect(devices.map((device) => [device.name, device.kind, device.reachable])).toEqual(
    expect.arrayContaining([
      ["Mac app", "desktop", true],
      ["Pixel", "phone", true],
    ]),
  );
  const mac = devices.find((device) => device.name === "Mac app")!;

  const receipt = await phone.sendFileToDevice({ deviceId: mac.deviceId, path: clip });

  expect(receipt).toEqual({ deviceName: "Mac app", delivery: "live" });
  const sent = await waitFor(() => desktop.received[0]);
  expect(sent).toMatchObject({
    type: "files.sent",
    payload: { path: clip, fileName: "clip.mp4", title: "clip.mp4 is ready" },
  });
  expect(pushes).toEqual([]);
});

test("a file sent to a phone goes out as a push naming the file, not as bytes", async () => {
  await phone.registerFileDevice({
    name: "Pixel",
    kind: "phone",
    pushToken: "ExponentPushToken[p]",
  });
  const pixel = (await ctx.client.listFileDevices()).find((device) => device.name === "Pixel")!;

  const receipt = await ctx.client.sendFileToDevice({ deviceId: pixel.deviceId, path: clip });

  expect(receipt.delivery).toBe("push");
  expect(pushes).toHaveLength(1);
  expect(pushes[0]?.tokens).toEqual(["ExponentPushToken[p]"]);
  expect(pushes[0]?.payload).toMatchObject({
    title: "clip.mp4 is ready",
    data: { sentFilePath: clip },
  });
  expect(pushes[0]?.payload.data?.serverId).toBeTruthy();
  expect(JSON.stringify(pushes[0])).not.toContain("bytes");
});

test("a phone with its app open also gets the note in the app", async () => {
  await phone.registerFileDevice({
    name: "Pixel",
    kind: "phone",
    pushToken: "ExponentPushToken[p]",
  });
  const inApp = collectSent(phone);
  await inApp.ready;
  phone.sendHeartbeat({
    deviceType: "mobile",
    focusedAgentId: null,
    lastActivityAt: new Date().toISOString(),
    appVisible: true,
  });
  const pixel = (await ctx.client.listFileDevices()).find((device) => device.name === "Pixel")!;
  await new Promise((resolve) => setTimeout(resolve, 200));

  await ctx.client.sendFileToDevice({ deviceId: pixel.deviceId, path: clip });

  expect(pushes).toHaveLength(1);
  expect(await waitFor(() => inApp.received[0])).toMatchObject({ type: "files.sent" });
});

test("refuses what cannot be sent", async () => {
  await phone.registerFileDevice({
    name: "Pixel",
    kind: "phone",
    pushToken: "ExponentPushToken[p]",
  });
  const pixel = (await ctx.client.listFileDevices()).find((device) => device.name === "Pixel")!;

  await expect(
    ctx.client.sendFileToDevice({ deviceId: pixel.deviceId, path: dir }),
  ).rejects.toThrow("not a file");
  await expect(
    ctx.client.sendFileToDevice({ deviceId: pixel.deviceId, path: "clip.mp4" }),
  ).rejects.toThrow("not an absolute path");
  await expect(ctx.client.sendFileToDevice({ deviceId: "nobody", path: clip })).rejects.toThrow(
    "Unknown device",
  );
  expect(pushes).toEqual([]);
});
