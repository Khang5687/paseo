import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { SidebarProjectOrder } from "@getpaseo/protocol/messages";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";

// One project order on every device. Each host keeps the order with the newest `updatedAt`; this
// device takes a host's order when it is newer and sends its own to any host holding an older one.
// A reorder made offline or while a host slept reaches that host when it reconnects, and from
// there every other device that watches it.

type ProjectOrderClient = Pick<
  DaemonClient,
  "observeSidebarProjectOrder" | "setSidebarProjectOrder"
>;

interface OrderState {
  projectOrder: string[];
  projectOrderUpdatedAt: number;
  applySyncedProjectOrder: (keys: string[], updatedAt: number) => boolean;
}

export interface ProjectOrderStore {
  getState(): OrderState;
  subscribe(listener: (state: OrderState, previous: OrderState) => void): () => void;
}

interface HostLink {
  client: ProjectOrderClient;
  /** Newest `updatedAt` the host is known to hold; null until its first snapshot. */
  hostUpdatedAt: number | null;
  release(): void;
}

export class ProjectOrderSync {
  private readonly hosts = new Map<string, HostLink>();
  private unsubscribeStore: (() => void) | null = null;

  constructor(
    private readonly store: ProjectOrderStore,
    /** Resolves once the local order is loaded, so a host's order is never overwritten by it. */
    private readonly hydrated: () => Promise<void>,
  ) {}

  connect(input: { serverId: string; client: ProjectOrderClient; supported: boolean }): void {
    if (this.hosts.get(input.serverId)?.client === input.client) return;
    this.disconnect(input.serverId);
    if (!input.supported) return;
    const subscription = input.client.observeSidebarProjectOrder();
    const link: HostLink = {
      client: input.client,
      hostUpdatedAt: null,
      release: () => {
        void subscription.release().catch(() => undefined);
      },
    };
    this.hosts.set(input.serverId, link);
    this.unsubscribeStore ??= this.store.subscribe((state, previous) => {
      if (state.projectOrderUpdatedAt === previous.projectOrderUpdatedAt) return;
      for (const host of this.hosts.values()) this.send(host);
    });
    const receive = (order: SidebarProjectOrder) => {
      void this.hydrated().then(() => this.receive(input.serverId, link, order));
    };
    subscription.subscribe({
      snapshot: receive,
      update: (message) => {
        if (message.type === "sidebar.project_order.update") receive(message.payload);
      },
      error: () => undefined,
    });
  }

  disconnect(serverId: string): void {
    this.hosts.get(serverId)?.release();
    this.hosts.delete(serverId);
    if (this.hosts.size > 0) return;
    this.unsubscribeStore?.();
    this.unsubscribeStore = null;
  }

  private receive(serverId: string, link: HostLink, host: SidebarProjectOrder): void {
    if (this.hosts.get(serverId) !== link) return;
    link.hostUpdatedAt = Math.max(link.hostUpdatedAt ?? 0, host.updatedAt);
    // A newer host order changes the local stamp, and the store listener passes it to other hosts.
    this.store.getState().applySyncedProjectOrder(host.order, host.updatedAt);
    this.send(link);
  }

  private send(link: HostLink): void {
    const { projectOrder, projectOrderUpdatedAt } = this.store.getState();
    if (link.hostUpdatedAt === null || projectOrderUpdatedAt <= link.hostUpdatedAt) return;
    void this.push(link, { order: projectOrder, updatedAt: projectOrderUpdatedAt });
  }

  private async push(link: HostLink, next: SidebarProjectOrder): Promise<void> {
    const previous = link.hostUpdatedAt;
    link.hostUpdatedAt = next.updatedAt;
    try {
      const result = await link.client.setSidebarProjectOrder(next);
      if (result.accepted) return;
      link.hostUpdatedAt = Math.max(link.hostUpdatedAt ?? 0, result.updatedAt);
      this.store.getState().applySyncedProjectOrder(result.order, result.updatedAt);
    } catch {
      // Not stored: the next reorder or reconnect sends it again.
      if (link.hostUpdatedAt === next.updatedAt) link.hostUpdatedAt = previous;
    }
  }
}

function sidebarOrderHydrated(): Promise<void> {
  if (useSidebarOrderStore.persist.hasHydrated()) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = useSidebarOrderStore.persist.onFinishHydration(() => {
      unsubscribe();
      resolve();
    });
  });
}

export const projectOrderSync = new ProjectOrderSync(useSidebarOrderStore, sidebarOrderHydrated);
