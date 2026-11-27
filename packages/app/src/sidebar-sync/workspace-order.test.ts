import type { SessionOutboundMessage, SidebarWorkspaceOrder } from "@getpaseo/protocol/messages";
import { mergeSidebarWorkspaceOrder } from "@getpaseo/protocol/sidebar-workspace-order";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import { sidebarWorkspaceOrderLocal, WorkspaceOrderSync } from "./workspace-order";

interface Observer {
  snapshot(payload: SidebarWorkspaceOrder): void;
  update(message: SessionOutboundMessage): void;
}

// A host that merges like the daemon's sidebar sync store: newest stamp wins per entry.
function fakeHost(initial: SidebarWorkspaceOrder) {
  let stored = initial;
  let observer: Observer | null = null;
  const client = {
    observeSidebarWorkspaceOrder: () => ({
      subscriptionId: "subscription",
      ready: Promise.resolve({ ...stored, requestId: "r", subscriptionId: "subscription" }),
      subscribe: (next: Observer) => {
        observer = next;
        queueMicrotask(() => next.snapshot(stored));
        return () => undefined;
      },
      release: async () => undefined,
    }),
    setSidebarWorkspaceOrder: vi.fn(async (next: SidebarWorkspaceOrder) => {
      stored = mergeSidebarWorkspaceOrder(stored, next).merged;
      return { requestId: "r", ...stored };
    }),
  };
  return {
    client: client as unknown as Parameters<WorkspaceOrderSync["connect"]>[0]["client"],
    sets: client.setSidebarWorkspaceOrder,
    stored: () => stored,
    // Another device changed something through this host.
    changeElsewhere(next: SidebarWorkspaceOrder) {
      stored = mergeSidebarWorkspaceOrder(stored, next).merged;
      observer?.update({ type: "sidebar.workspace_order.update", payload: stored });
    },
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe("WorkspaceOrderSync", () => {
  let sync: WorkspaceOrderSync;

  beforeEach(() => {
    useSidebarOrderStore.setState({
      workspaceOrderByProject: {},
      workspaceOrderUpdatedAtByProject: {},
    });
    useSidebarViewStore.setState({ workspaceSort: "created", workspaceSortUpdatedAt: 0 });
    sync = new WorkspaceOrderSync({
      ...sidebarWorkspaceOrderLocal,
      hydrated: () => Promise.resolve(),
    });
  });

  afterEach(async () => {
    for (const serverId of ["omen", "mac"]) sync.disconnect(serverId);
    await settle();
  });

  it("takes a host's newer order and sort, keeping workspaces only this device knows after", async () => {
    useSidebarOrderStore.setState({
      workspaceOrderByProject: { alpha: ["h:1", "h:2", "mac:9"] },
      workspaceOrderUpdatedAtByProject: { alpha: 10 },
    });
    const host = fakeHost({
      projects: { alpha: { order: ["h:2", "h:1"], updatedAt: 20 } },
      sort: { value: "manual", updatedAt: 20 },
    });

    sync.connect({ serverId: "omen", client: host.client, supported: true });
    await settle();

    expect(useSidebarOrderStore.getState().workspaceOrderByProject.alpha).toEqual([
      "h:2",
      "h:1",
      "mac:9",
    ]);
    expect(useSidebarViewStore.getState().workspaceSort).toBe("manual");
    expect(host.sets).not.toHaveBeenCalled();
  });

  it("keeps the newest order of each project: one from the host, one from this device", async () => {
    useSidebarOrderStore.getState().setWorkspaceOrder("beta", ["h:4", "h:3"]);
    const stamp = useSidebarOrderStore.getState().workspaceOrderUpdatedAtByProject.beta;
    const host = fakeHost({
      projects: {
        alpha: { order: ["h:2", "h:1"], updatedAt: stamp + 1000 },
        beta: { order: ["h:3", "h:4"], updatedAt: stamp - 1000 },
      },
    });

    sync.connect({ serverId: "mac", client: host.client, supported: true });
    await settle();

    expect(useSidebarOrderStore.getState().workspaceOrderByProject).toEqual({
      alpha: ["h:2", "h:1"],
      beta: ["h:4", "h:3"],
    });
    expect(host.stored().projects).toEqual({
      alpha: { order: ["h:2", "h:1"], updatedAt: stamp + 1000 },
      beta: { order: ["h:4", "h:3"], updatedAt: stamp },
    });
  });

  it("passes a change from one host's device to the other hosts", async () => {
    const omen = fakeHost({ projects: {} });
    const mac = fakeHost({ projects: {} });
    sync.connect({ serverId: "omen", client: omen.client, supported: true });
    sync.connect({ serverId: "mac", client: mac.client, supported: true });
    await settle();

    omen.changeElsewhere({
      projects: { alpha: { order: ["h:2", "h:1"], updatedAt: 50 } },
      sort: { value: "manual", updatedAt: 50 },
    });
    await settle();

    expect(useSidebarViewStore.getState().workspaceSort).toBe("manual");
    expect(mac.stored()).toEqual({
      projects: { alpha: { order: ["h:2", "h:1"], updatedAt: 50 } },
      sort: { value: "manual", updatedAt: 50 },
    });
    expect(omen.sets).not.toHaveBeenCalled();
  });

  it("sends a person's reorder and sort pick, but not workspaces the sidebar only found", async () => {
    const host = fakeHost({ projects: {} });
    sync.connect({ serverId: "omen", client: host.client, supported: true });
    await settle();

    useSidebarOrderStore.getState().extendWorkspaceOrder("alpha", ["h:1", "h:2"]);
    await settle();
    expect(host.sets).not.toHaveBeenCalled();

    useSidebarOrderStore.getState().setWorkspaceOrder("alpha", ["h:2", "h:1"]);
    useSidebarViewStore.getState().setWorkspaceSort("lastPrompt");
    await settle();
    expect(host.stored().projects.alpha?.order).toEqual(["h:2", "h:1"]);
    expect(host.stored().sort?.value).toBe("lastPrompt");
  });

  it("leaves a sort this app does not know on the host", async () => {
    const host = fakeHost({ projects: {}, sort: { value: "alphabetical", updatedAt: 99 } });

    sync.connect({ serverId: "omen", client: host.client, supported: true });
    await settle();

    expect(useSidebarViewStore.getState().workspaceSort).toBe("created");
    expect(host.sets).not.toHaveBeenCalled();
  });
});
