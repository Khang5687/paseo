import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

const daemons = new Set<TestPaseoDaemon>();
const clients = new Set<DaemonClient>();
const homes = new Set<string>();

afterEach(async () => {
  await Promise.all(Array.from(clients, (client) => client.close().catch(() => undefined)));
  clients.clear();
  await Promise.all(Array.from(daemons, (daemon) => daemon.close().catch(() => undefined)));
  daemons.clear();
  await Promise.all(Array.from(homes, (home) => rm(home, { recursive: true, force: true })));
  homes.clear();
});

async function connect(daemon: TestPaseoDaemon): Promise<DaemonClient> {
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  clients.add(client);
  await client.connect();
  return client;
}

function nextOrder(subscription: ReturnType<DaemonClient["observeSidebarProjectOrder"]>) {
  return new Promise<{ order: string[]; updatedAt: number }>((resolve) => {
    const stop = subscription.subscribe({
      snapshot: () => undefined,
      update: (message) => {
        if (message.type !== "sidebar.project_order.update") return;
        stop();
        resolve({ order: message.payload.order, updatedAt: message.payload.updatedAt });
      },
    });
  });
}

test("the newest project order wins and reaches every watching device, across restarts", async () => {
  const paseoHomeRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-project-order-"));
  homes.add(paseoHomeRoot);
  // cleanup: false keeps the home for the second daemon; afterEach removes it.
  const first = await createTestPaseoDaemon({ paseoHomeRoot, cleanup: false });
  daemons.add(first);
  homes.add(first.staticDir);
  const phone = await connect(first);
  const mac = await connect(first);
  expect(phone.getLastServerInfoMessage()?.features?.sidebarProjectOrder).toBe(true);

  const watching = mac.observeSidebarProjectOrder();
  const initial = await watching.ready;
  expect({ order: initial.order, updatedAt: initial.updatedAt }).toEqual({
    order: [],
    updatedAt: 0,
  });

  const update = nextOrder(watching);
  const stored = await phone.setSidebarProjectOrder({ order: ["beta", "alpha"], updatedAt: 200 });
  expect(stored).toMatchObject({ accepted: true, order: ["beta", "alpha"], updatedAt: 200 });
  await expect(update).resolves.toEqual({ order: ["beta", "alpha"], updatedAt: 200 });

  // A device that slept with an older reorder gets the newer order back instead.
  const stale = await mac.setSidebarProjectOrder({ order: ["alpha", "beta"], updatedAt: 100 });
  expect(stale).toMatchObject({ accepted: false, order: ["beta", "alpha"], updatedAt: 200 });
  await watching.release();

  await first.close();
  daemons.delete(first);
  const second = await createTestPaseoDaemon({ paseoHomeRoot });
  daemons.add(second);
  const later = await connect(second);
  const reloaded = await later.observeSidebarProjectOrder().ready;
  expect({ order: reloaded.order, updatedAt: reloaded.updatedAt }).toEqual({
    order: ["beta", "alpha"],
    updatedAt: 200,
  });
});

test("each project's workspace order and the sort keep their own newest stamp", async () => {
  const paseoHomeRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-workspace-order-"));
  homes.add(paseoHomeRoot);
  const first = await createTestPaseoDaemon({ paseoHomeRoot, cleanup: false });
  daemons.add(first);
  homes.add(first.staticDir);
  const phone = await connect(first);
  const mac = await connect(first);
  expect(phone.getLastServerInfoMessage()?.features?.sidebarWorkspaceOrder).toBe(true);

  const watching = mac.observeSidebarWorkspaceOrder();
  const initial = await watching.ready;
  expect(initial.projects).toEqual({});
  expect(initial.sort).toBeUndefined();

  const update = new Promise<unknown>((resolve) => {
    const stop = watching.subscribe({
      snapshot: () => undefined,
      update: (message) => {
        if (message.type !== "sidebar.workspace_order.update") return;
        stop();
        resolve({ projects: message.payload.projects, sort: message.payload.sort });
      },
    });
  });
  await phone.setSidebarWorkspaceOrder({
    projects: { alpha: { order: ["h:2", "h:1"], updatedAt: 200 } },
    sort: { value: "manual", updatedAt: 200 },
  });
  await expect(update).resolves.toEqual({
    projects: { alpha: { order: ["h:2", "h:1"], updatedAt: 200 } },
    sort: { value: "manual", updatedAt: 200 },
  });

  // The Mac slept through that: its older alpha order and sort lose, its beta reorder is kept.
  const merged = await mac.setSidebarWorkspaceOrder({
    projects: {
      alpha: { order: ["h:1", "h:2"], updatedAt: 100 },
      beta: { order: ["h:3", "h:4"], updatedAt: 150 },
    },
    sort: { value: "created", updatedAt: 100 },
  });
  expect({ projects: merged.projects, sort: merged.sort }).toEqual({
    projects: {
      alpha: { order: ["h:2", "h:1"], updatedAt: 200 },
      beta: { order: ["h:3", "h:4"], updatedAt: 150 },
    },
    sort: { value: "manual", updatedAt: 200 },
  });
  await watching.release();

  await first.close();
  daemons.delete(first);
  const second = await createTestPaseoDaemon({ paseoHomeRoot });
  daemons.add(second);
  const later = await connect(second);
  const reloaded = await later.observeSidebarWorkspaceOrder().ready;
  expect({ projects: reloaded.projects, sort: reloaded.sort }).toEqual({
    projects: merged.projects,
    sort: merged.sort,
  });
  // The project order beside it is untouched.
  expect((await later.observeSidebarProjectOrder().ready).updatedAt).toBe(0);
});
