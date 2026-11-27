import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { SidebarWorkspaceOrder } from "@getpaseo/protocol/messages";
import {
  mergeSidebarWorkspaceOrder,
  newerSidebarWorkspaceOrderEntries,
} from "@getpaseo/protocol/sidebar-workspace-order";
import type { WorkspaceSort } from "@/projects/workspace-structure";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";

// One workspace order per project, and one sort, on every device. Each host keeps, per project
// and for the sort, the entry with the newest `updatedAt`; this device takes a host's newer entries
// and sends its own newer ones. A reorder made offline or while a host slept reaches that host when
// it reconnects, and from there every other device that watches it. Same model as the project
// order (`project-order.ts`), with a stamp per entry so two projects never undo each other.

type WorkspaceOrderClient = Pick<
  DaemonClient,
  "observeSidebarWorkspaceOrder" | "setSidebarWorkspaceOrder"
>;

/** This device's copy: only what a person changed here carries a stamp. */
export interface WorkspaceOrderLocal {
  read(): SidebarWorkspaceOrder;
  /** Takes the entries of `host` that are newer than this device's. */
  apply(host: SidebarWorkspaceOrder): void;
  /** Calls back when a stamp changes: a person's change here, or a newer host entry. */
  subscribe(listener: () => void): () => void;
  /** Resolves once the local copy is loaded, so a host's state is never overwritten by it. */
  hydrated(): Promise<void>;
}

interface HostLink {
  client: WorkspaceOrderClient;
  /** What the host is known to hold; null until its first snapshot. */
  host: SidebarWorkspaceOrder | null;
  release(): void;
}

function toWorkspaceOrder(payload: SidebarWorkspaceOrder): SidebarWorkspaceOrder {
  return payload.sort
    ? { projects: payload.projects, sort: payload.sort }
    : { projects: payload.projects };
}

export class WorkspaceOrderSync {
  private readonly hosts = new Map<string, HostLink>();
  private unsubscribeLocal: (() => void) | null = null;

  constructor(private readonly local: WorkspaceOrderLocal) {}

  connect(input: { serverId: string; client: WorkspaceOrderClient; supported: boolean }): void {
    if (this.hosts.get(input.serverId)?.client === input.client) return;
    this.disconnect(input.serverId);
    if (!input.supported) return;
    const subscription = input.client.observeSidebarWorkspaceOrder();
    const link: HostLink = {
      client: input.client,
      host: null,
      release: () => {
        void subscription.release().catch(() => undefined);
      },
    };
    this.hosts.set(input.serverId, link);
    this.unsubscribeLocal ??= this.local.subscribe(() => {
      for (const host of this.hosts.values()) this.send(host);
    });
    const receive = (payload: SidebarWorkspaceOrder) => {
      const host = toWorkspaceOrder(payload);
      void this.local.hydrated().then(() => this.receive(input.serverId, link, host));
    };
    subscription.subscribe({
      snapshot: receive,
      update: (message) => {
        if (message.type === "sidebar.workspace_order.update") receive(message.payload);
      },
      error: () => undefined,
    });
  }

  disconnect(serverId: string): void {
    this.hosts.get(serverId)?.release();
    this.hosts.delete(serverId);
    if (this.hosts.size > 0) return;
    this.unsubscribeLocal?.();
    this.unsubscribeLocal = null;
  }

  private receive(serverId: string, link: HostLink, host: SidebarWorkspaceOrder): void {
    if (this.hosts.get(serverId) !== link) return;
    link.host = link.host ? mergeSidebarWorkspaceOrder(link.host, host).merged : host;
    // Newer host entries change local stamps, and the local listener passes them to other hosts.
    this.local.apply(host);
    this.send(link);
  }

  private send(link: HostLink): void {
    if (!link.host) return;
    const newer = newerSidebarWorkspaceOrderEntries(this.local.read(), link.host);
    if (newer) void this.push(link, link.host, newer);
  }

  private async push(
    link: HostLink,
    previous: SidebarWorkspaceOrder,
    newer: SidebarWorkspaceOrder,
  ): Promise<void> {
    const sent = mergeSidebarWorkspaceOrder(previous, newer).merged;
    link.host = sent;
    try {
      const result = toWorkspaceOrder(await link.client.setSidebarWorkspaceOrder(newer));
      if (!this.isLinked(link)) return;
      link.host = mergeSidebarWorkspaceOrder(link.host ?? result, result).merged;
      // The host may hold newer entries than this device sent; take them.
      this.local.apply(result);
    } catch {
      // Not stored: the next change or reconnect sends it again.
      if (link.host === sent) link.host = previous;
    }
  }

  private isLinked(link: HostLink): boolean {
    for (const linked of this.hosts.values()) if (linked === link) return true;
    return false;
  }
}

const WORKSPACE_SORTS: readonly WorkspaceSort[] = ["manual", "created", "lastPrompt", "urgent"];

function isWorkspaceSort(value: string): value is WorkspaceSort {
  return (WORKSPACE_SORTS as readonly string[]).includes(value);
}

function storeHydrated(store: {
  persist: { hasHydrated(): boolean; onFinishHydration(listener: () => void): () => void };
}): Promise<void> {
  if (store.persist.hasHydrated()) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = store.persist.onFinishHydration(() => {
      unsubscribe();
      resolve();
    });
  });
}

/** The workspace orders live in the order store, the sort in the view store. */
export const sidebarWorkspaceOrderLocal: WorkspaceOrderLocal = {
  read() {
    const orders = useSidebarOrderStore.getState();
    const projects: SidebarWorkspaceOrder["projects"] = {};
    for (const [projectKey, updatedAt] of Object.entries(orders.workspaceOrderUpdatedAtByProject)) {
      projects[projectKey] = { order: orders.workspaceOrderByProject[projectKey] ?? [], updatedAt };
    }
    const view = useSidebarViewStore.getState();
    return view.workspaceSortUpdatedAt > 0
      ? {
          projects,
          sort: { value: view.workspaceSort, updatedAt: view.workspaceSortUpdatedAt },
        }
      : { projects };
  },
  apply(host) {
    useSidebarOrderStore.getState().applySyncedWorkspaceOrders(host.projects);
    // A sort this app does not know stays on the host for the apps that do.
    if (host.sort && isWorkspaceSort(host.sort.value)) {
      useSidebarViewStore.getState().applySyncedWorkspaceSort(host.sort.value, host.sort.updatedAt);
    }
  },
  subscribe(listener) {
    const stopOrders = useSidebarOrderStore.subscribe((state, previous) => {
      if (state.workspaceOrderUpdatedAtByProject !== previous.workspaceOrderUpdatedAtByProject) {
        listener();
      }
    });
    const stopSort = useSidebarViewStore.subscribe((state, previous) => {
      if (state.workspaceSortUpdatedAt !== previous.workspaceSortUpdatedAt) listener();
    });
    return () => {
      stopOrders();
      stopSort();
    };
  },
  hydrated: () =>
    Promise.all([storeHydrated(useSidebarOrderStore), storeHydrated(useSidebarViewStore)]).then(
      () => undefined,
    ),
};

export const workspaceOrderSync = new WorkspaceOrderSync(sidebarWorkspaceOrderLocal);
