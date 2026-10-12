import { useEffect, useState, useSyncExternalStore } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  OmpAccountLoginStatus,
  OmpAccountRoutingMutation,
  OmpAccountRoutingState,
} from "@getpaseo/protocol/messages";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

export type RoutingClient = Pick<
  DaemonClient,
  "getOmpAccountRoutingState" | "mutateOmpAccountRouting"
>;

export type RoutingMutationError = "invalid_account" | "unsupported" | "persistence_failed";

export interface RoutingSnapshot {
  /** Last host-confirmed state. Never holds an attempted mutation. */
  state: OmpAccountRoutingState | null;
  /** The connection to the host dropped after the state was confirmed. */
  offline: boolean;
  pending: boolean;
  /** A stale revision lost; `state` is already the host's current one. */
  conflict: boolean;
  error: RoutingMutationError | null;
  /** Wait ids whose recovery the current state is the first to show. */
  recoveries: ReadonlySet<string>;
}

const INITIAL: RoutingSnapshot = {
  state: null,
  offline: false,
  pending: false,
  conflict: false,
  error: null,
  recoveries: new Set(),
};

/** A snapshot is older only within one host epoch; a new epoch always replaces. */
function isNewer(next: OmpAccountRoutingState, current: OmpAccountRoutingState | null): boolean {
  return (
    !current || next.hostEpoch !== current.hostEpoch || next.stateSequence >= current.stateSequence
  );
}

/**
 * One host's routing observation and mutations. Plain TypeScript: the hook below only gives it a
 * lifetime. State changes only from host-committed snapshots; a mutation never shows as applied
 * before the host answers, and a dropped connection is never replayed.
 */
export class RoutingController {
  private snapshot: RoutingSnapshot = INITIAL;
  private readonly listeners = new Set<() => void>();
  private client: RoutingClient | null = null;
  private release: (() => Promise<void>) | null = null;
  private attachId = 0;
  private readonly seenRecoveries = new Set<string>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): RoutingSnapshot => this.snapshot;

  /** Observe the host. Safe to call again after `detach`; the last confirmed state is kept. */
  attach(client: RoutingClient): void {
    this.detach();
    this.client = client;
    void this.observe(client, ++this.attachId);
  }

  private async observe(client: RoutingClient, id: number): Promise<void> {
    try {
      const read = await client.getOmpAccountRoutingState({ subscribe: {} });
      const subscription = read.subscription;
      if (id !== this.attachId || !subscription) {
        await subscription?.release();
        return;
      }
      this.release = () => subscription.release();
      this.accept(read.state);
      subscription.subscribe({
        snapshot: (state) => {
          if (id === this.attachId) this.accept(state);
        },
        update: (message) => {
          if (id === this.attachId && message.type === "account.routing.state.update") {
            this.accept(message.payload.state);
          }
        },
        error: () => {
          if (id === this.attachId) this.markOffline();
        },
      });
    } catch {
      if (id === this.attachId) this.markOffline();
    }
  }

  detach(): void {
    this.attachId += 1;
    this.client = null;
    const release = this.release;
    this.release = null;
    void release?.().catch(() => undefined);
    // A drop after the first snapshot keeps it, marked offline. Pending work has no outcome to show.
    this.set({ offline: this.snapshot.state !== null, pending: false });
  }

  async mutate(command: OmpAccountRoutingMutation): Promise<void> {
    const { client, snapshot } = this;
    const state = snapshot.state;
    if (!client || !state || snapshot.pending || snapshot.offline) return;
    const id = this.attachId;
    this.set({ pending: true, error: null });
    try {
      const result = await client.mutateOmpAccountRouting({
        expectedPolicyRevision: state.policy.policyRevision,
        command,
      });
      if (id !== this.attachId) return;
      const error = result.error?.code ?? null;
      this.accept(result.state, {
        pending: false,
        conflict: error === "conflict",
        error: error === null || error === "conflict" ? null : error,
      });
    } catch {
      // Transport failure: the host may or may not have applied it. Claim neither.
      if (id !== this.attachId) return;
      this.markOffline();
      this.attach(client);
    }
  }

  private accept(state: OmpAccountRoutingState, patch: Partial<RoutingSnapshot> = {}): void {
    const next = isNewer(state, this.snapshot.state) ? state : this.snapshot.state;
    this.set({ ...patch, offline: false, state: next, recoveries: this.freshRecoveries(next) });
  }

  /** A recovery is fresh only in the first state that carries it; later states drop it. */
  private freshRecoveries(next: OmpAccountRoutingState | null): ReadonlySet<string> {
    if (next === this.snapshot.state) return this.snapshot.recoveries;
    const fresh = new Set<string>();
    for (const request of next?.pausedRequests ?? []) {
      if (request.recoveredAt === null || this.seenRecoveries.has(request.waitId)) continue;
      fresh.add(request.waitId);
      this.seenRecoveries.add(request.waitId);
    }
    return fresh;
  }

  private markOffline(): void {
    this.set({ offline: this.snapshot.state !== null, pending: false });
  }

  private set(patch: Partial<RoutingSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}

export type LoginClient = Pick<
  DaemonClient,
  "startOmpAccountLogin" | "getOmpAccountLoginStatus" | "cancelOmpAccountLogin"
>;

export type LoginFailure = NonNullable<OmpAccountLoginStatus["failure"]> | "unreachable";

export interface LoginSnapshot {
  phase: "idle" | "starting" | "running" | "succeeded" | "failed" | "cancelled";
  failure: LoginFailure | null;
}

const LOGIN_POLL_MS = 2_000;
const LOGIN_IDLE: LoginSnapshot = { phase: "idle", failure: null };

/**
 * Drives one host-side Claude sign-in. The host opens the browser and finishes the login itself;
 * this only starts it, polls the outcome, and cancels. Nothing secret is ever in a status.
 */
export class AccountLoginController {
  private snapshot: LoginSnapshot = LOGIN_IDLE;
  private readonly listeners = new Set<() => void>();
  private client: LoginClient | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private attachId = 0;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): LoginSnapshot => this.snapshot;

  attach(client: LoginClient): void {
    this.detach();
    this.client = client;
    const id = this.attachId;
    // A page opened mid-login shows it; a finished one is old news.
    void (async () => {
      try {
        const { status } = await client.getOmpAccountLoginStatus();
        if (id === this.attachId && status.state === "running") this.adopt(status);
      } catch {
        // The first poll or a start will surface a dead connection.
      }
    })();
  }

  detach(): void {
    this.attachId += 1;
    this.client = null;
    this.stopPolling();
    if (this.snapshot.phase === "running" || this.snapshot.phase === "starting") {
      this.set(LOGIN_IDLE);
    }
  }

  async start(): Promise<void> {
    const client = this.client;
    const phase = this.snapshot.phase;
    if (!client || phase === "starting" || phase === "running") return;
    const id = this.attachId;
    this.set({ phase: "starting", failure: null });
    try {
      const { status } = await client.startOmpAccountLogin();
      if (id === this.attachId) this.adopt(status);
    } catch {
      if (id === this.attachId) this.set({ phase: "failed", failure: "unreachable" });
    }
  }

  async cancel(): Promise<void> {
    const client = this.client;
    if (!client || this.snapshot.phase !== "running") return;
    const id = this.attachId;
    try {
      const { status } = await client.cancelOmpAccountLogin();
      if (id === this.attachId) this.adopt(status);
    } catch {
      if (id === this.attachId) this.set({ phase: "failed", failure: "unreachable" });
    }
  }

  private adopt(status: OmpAccountLoginStatus): void {
    if (status.state === "running") {
      this.set({ phase: "running", failure: null });
      this.startPolling();
      return;
    }
    this.stopPolling();
    if (status.state === "idle") this.set(LOGIN_IDLE);
    else this.set({ phase: status.state, failure: status.failure ?? null });
  }

  private startPolling(): void {
    if (this.timer) return;
    const id = this.attachId;
    this.timer = setInterval(() => void this.poll(id), LOGIN_POLL_MS);
  }

  private async poll(id: number): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      const { status } = await client.getOmpAccountLoginStatus();
      if (id === this.attachId) this.adopt(status);
    } catch {
      if (id !== this.attachId) return;
      this.stopPolling();
      this.set({ phase: "failed", failure: "unreachable" });
    }
  }

  private stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private set(next: LoginSnapshot): void {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

export interface HostAccountLogin {
  snapshot: LoginSnapshot;
  /** The host can sign accounts in (macOS with routing). */
  featureOn: boolean;
  /** This app is the desktop app and the host is the daemon on this same computer. */
  onHostComputer: boolean;
  start: () => void;
  cancel: () => void;
}

/** Add-account for one host. Mount with `key={serverId}` so hosts never share state. */
export function useHostAccountLogin(serverId: string): HostAccountLogin {
  const [controller] = useState(() => new AccountLoginController());
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const featureOn = useHostFeature(serverId, "ompAccountLogin");
  const onHostComputer = useIsLocalDaemon(serverId);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);

  useEffect(() => {
    if (!client || !connected || !featureOn || !onHostComputer) return undefined;
    controller.attach(client);
    return () => controller.detach();
  }, [client, connected, controller, featureOn, onHostComputer]);

  return {
    snapshot,
    featureOn,
    onHostComputer,
    start: () => void controller.start(),
    cancel: () => void controller.cancel(),
  };
}

export interface HostAccountRouting {
  snapshot: RoutingSnapshot;
  /** The host advertises routing support right now. */
  featureOn: boolean;
  connected: boolean;
  /** Missing permission data counts as read-only for this gated feature. */
  canEdit: boolean;
  mutate: (command: OmpAccountRoutingMutation) => void;
}

/** Account routing for one host. Mount with `key={serverId}` so hosts never share state. */
export function useHostAccountRouting(serverId: string): HostAccountRouting {
  const [controller] = useState(() => new RoutingController());
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const featureOn = useHostFeature(serverId, "ompAccountRouting");
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);

  useEffect(() => {
    if (!client || !connected || !featureOn) return undefined;
    controller.attach(client);
    return () => controller.detach();
  }, [client, connected, controller, featureOn]);

  const permissions = client?.getLastServerInfoMessage()?.permissions;
  return {
    snapshot,
    featureOn,
    connected,
    canEdit: permissions?.includes("daemon.manage") === true,
    mutate: (command) => void controller.mutate(command),
  };
}
