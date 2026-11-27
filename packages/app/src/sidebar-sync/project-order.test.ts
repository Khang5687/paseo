import type { SessionOutboundMessage, SidebarProjectOrder } from "@getpaseo/protocol/messages";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import { ProjectOrderSync } from "./project-order";

interface Observer {
  snapshot(payload: SidebarProjectOrder): void;
  update(message: SessionOutboundMessage): void;
}

// A host that keeps the newest order, like the daemon's sidebar sync store.
function fakeHost(initial: SidebarProjectOrder) {
  let stored = initial;
  let observer: Observer | null = null;
  const client = {
    observeSidebarProjectOrder: () => ({
      subscriptionId: "subscription",
      ready: Promise.resolve({ ...stored, requestId: "r", subscriptionId: "subscription" }),
      subscribe: (next: Observer) => {
        observer = next;
        queueMicrotask(() => next.snapshot(stored));
        return () => undefined;
      },
      release: async () => undefined,
    }),
    setSidebarProjectOrder: vi.fn(async (next: SidebarProjectOrder) => {
      const accepted = next.updatedAt > stored.updatedAt;
      if (accepted) stored = { order: next.order, updatedAt: next.updatedAt };
      return { requestId: "r", accepted, ...stored };
    }),
  };
  return {
    client: client as unknown as Parameters<ProjectOrderSync["connect"]>[0]["client"],
    sets: client.setSidebarProjectOrder,
    stored: () => stored,
    // Another device reordered through this host.
    reorderElsewhere(order: SidebarProjectOrder) {
      stored = order;
      observer?.update({ type: "sidebar.project_order.update", payload: order });
    },
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

describe("ProjectOrderSync", () => {
  let sync: ProjectOrderSync;

  beforeEach(() => {
    useSidebarOrderStore.setState({ projectOrder: [], projectOrderUpdatedAt: 0 });
    sync = new ProjectOrderSync(useSidebarOrderStore, () => Promise.resolve());
  });

  it("takes a host's newer order and keeps projects only this device knows after it", async () => {
    useSidebarOrderStore.setState({ projectOrder: ["a", "b", "local"], projectOrderUpdatedAt: 10 });
    const host = fakeHost({ order: ["b", "a"], updatedAt: 20 });

    sync.connect({ serverId: "omen", client: host.client, supported: true });
    await settle();

    expect(useSidebarOrderStore.getState().projectOrder).toEqual(["b", "a", "local"]);
    expect(useSidebarOrderStore.getState().projectOrderUpdatedAt).toBe(20);
    expect(host.sets).not.toHaveBeenCalled();
  });

  it("sends a reorder made while the host slept once the host is back", async () => {
    useSidebarOrderStore.getState().setProjectOrder(["b", "a"]);
    const stamp = useSidebarOrderStore.getState().projectOrderUpdatedAt;
    const host = fakeHost({ order: ["a", "b"], updatedAt: stamp - 1000 });

    sync.connect({ serverId: "mac", client: host.client, supported: true });
    await settle();

    expect(host.stored()).toEqual({ order: ["b", "a"], updatedAt: stamp });
  });

  it("passes a reorder from one host's device to the other hosts", async () => {
    const omen = fakeHost({ order: ["a", "b"], updatedAt: 0 });
    const mac = fakeHost({ order: ["a", "b"], updatedAt: 0 });
    sync.connect({ serverId: "omen", client: omen.client, supported: true });
    sync.connect({ serverId: "mac", client: mac.client, supported: true });
    await settle();

    omen.reorderElsewhere({ order: ["b", "a"], updatedAt: 50 });
    await settle();

    expect(useSidebarOrderStore.getState().projectOrder).toEqual(["b", "a"]);
    expect(mac.stored()).toEqual({ order: ["b", "a"], updatedAt: 50 });
    expect(omen.sets).not.toHaveBeenCalled();
  });

  it("sends a reorder here to every host, but not projects the sidebar only found", async () => {
    const omen = fakeHost({ order: [], updatedAt: 0 });
    const mac = fakeHost({ order: [], updatedAt: 0 });
    sync.connect({ serverId: "omen", client: omen.client, supported: true });
    sync.connect({ serverId: "mac", client: mac.client, supported: true });
    await settle();

    useSidebarOrderStore.getState().extendProjectOrder(["a", "b"]);
    await settle();
    expect(omen.sets).not.toHaveBeenCalled();

    useSidebarOrderStore.getState().setProjectOrder(["b", "a"]);
    await settle();
    expect(omen.stored().order).toEqual(["b", "a"]);
    expect(mac.stored().order).toEqual(["b", "a"]);
  });

  it("leaves hosts without the feature alone", async () => {
    const host = fakeHost({ order: ["b", "a"], updatedAt: 20 });
    const observe = vi.spyOn(host.client, "observeSidebarProjectOrder");

    sync.connect({ serverId: "old", client: host.client, supported: false });
    useSidebarOrderStore.getState().setProjectOrder(["a", "b"]);
    await settle();

    expect(observe).not.toHaveBeenCalled();
    expect(host.sets).not.toHaveBeenCalled();
  });
});
