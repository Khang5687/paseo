import { useEffect, useState, useSyncExternalStore } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  AccountRoutingLoginSubmitCodeResponse,
  OmpAccountLoginStatus,
  OmpAccountRoutingMutation,
  OmpAccountRoutingState,
  OmpRoutingAccountRef,
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
  | "startOmpAccountLogin"
  | "getOmpAccountLoginStatus"
  | "cancelOmpAccountLogin"
  | "submitOmpAccountLoginCode"
>;

export type LoginFailure = NonNullable<OmpAccountLoginStatus["failure"]> | "unreachable";

export type LoginOutcome = NonNullable<OmpAccountLoginStatus["outcome"]>;

/** Why the host refused a pasted address or code, or `unreachable` when it never answered. */
export type PasteError =
  | NonNullable<AccountRoutingLoginSubmitCodeResponse["payload"]["error"]>
  | "unreachable";

export interface LoginSnapshot {
  phase: "idle" | "starting" | "running" | "succeeded" | "failed" | "cancelled";
  failure: LoginFailure | null;
  /** The host's step while running. */
  step: "preparing" | "awaiting_browser" | "verifying" | null;
  /** https sign-in link. Held in memory only; the host sends it to its own app alone. */
  authorizeUrl: string | null;
  /** OMP is waiting for a pasted address or code. */
  pasteAccepted: boolean;
  outcome: LoginOutcome | null;
  endedAt: number | null;
  submitting: boolean;
  pasteError: PasteError | null;
  /** The account the last sign-in added. Survives dismissing the result; cleared on leaving the page. */
  justAdded: OmpRoutingAccountRef | null;
}

const LOGIN_POLL_MS = 2_000;
/** A login that ended this recently is still shown after a reload. */
export const FINISHED_LOGIN_VISIBLE_MS = 5 * 60 * 1000;
const LOGIN_IDLE: LoginSnapshot = {
  phase: "idle",
  failure: null,
  step: null,
  authorizeUrl: null,
  pasteAccepted: false,
  outcome: null,
  endedAt: null,
  submitting: false,
  pasteError: null,
  justAdded: null,
};

/**
 * Drives one host-side Claude sign-in. The app opens the link itself; this only starts the login,
 * polls its status, forwards a pasted address, and cancels. No token is ever in a status.
 */
export class AccountLoginController {
  private snapshot: LoginSnapshot = LOGIN_IDLE;
  private readonly listeners = new Set<() => void>();
  private client: LoginClient | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private attachId = 0;

  constructor(private readonly now: () => number = Date.now) {}

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
    // A page opened mid-login adopts it; one that ended minutes ago still shows its outcome.
    void (async () => {
      try {
        const { status } = await client.getOmpAccountLoginStatus();
        if (id !== this.attachId) return;
        const recent =
          status.endedAt !== undefined && this.now() - status.endedAt < FINISHED_LOGIN_VISIBLE_MS;
        if (status.state === "running" || (status.state !== "idle" && recent)) this.adopt(status);
      } catch {
        // The first poll or a start will surface a dead connection.
      }
    })();
  }

  detach(): void {
    this.attachId += 1;
    this.client = null;
    this.stopPolling();
    this.set(LOGIN_IDLE);
  }

  async start(): Promise<void> {
    const client = this.client;
    const phase = this.snapshot.phase;
    if (!client || phase === "starting" || phase === "running") return;
    const id = this.attachId;
    this.set({ ...LOGIN_IDLE, phase: "starting", step: "preparing", justAdded: null });
    try {
      const { status } = await client.startOmpAccountLogin({ mode: "add" });
      if (id === this.attachId) this.adopt(status);
    } catch {
      if (id === this.attachId) this.fail("unreachable");
    }
  }

  async cancel(): Promise<void> {
    const client = this.client;
    if (!client || (this.snapshot.phase !== "running" && this.snapshot.phase !== "starting"))
      return;
    const id = this.attachId;
    try {
      const { status } = await client.cancelOmpAccountLogin();
      if (id === this.attachId) this.adopt(status);
    } catch {
      if (id === this.attachId) this.fail("unreachable");
    }
  }

  /** Sends the pasted address or code to the host's open prompt. */
  async submitCode(input: string): Promise<void> {
    const client = this.client;
    const { phase, pasteAccepted, submitting } = this.snapshot;
    if (!client || phase !== "running" || !pasteAccepted || submitting) return;
    const id = this.attachId;
    this.set({ submitting: true, pasteError: null });
    try {
      const { status, error } = await client.submitOmpAccountLoginCode(input);
      if (id === this.attachId) this.adopt(status, { pasteError: error });
    } catch {
      if (id === this.attachId) this.set({ submitting: false, pasteError: "unreachable" });
    }
  }

  /** Clears a finished result. A running login is untouched. */
  dismiss(): void {
    const { phase, justAdded } = this.snapshot;
    if (phase === "running" || phase === "starting") return;
    this.set({ ...LOGIN_IDLE, justAdded });
  }

  private fail(failure: LoginFailure): void {
    this.stopPolling();
    this.set({ ...LOGIN_IDLE, phase: "failed", failure, justAdded: this.snapshot.justAdded });
  }

  private adopt(
    status: OmpAccountLoginStatus,
    extra: { pasteError?: PasteError | null } = {},
  ): void {
    if (status.state === "idle") {
      this.stopPolling();
      this.set({ ...LOGIN_IDLE, justAdded: this.snapshot.justAdded });
      return;
    }
    const running = status.state === "running";
    if (running) this.startPolling();
    else this.stopPolling();
    const outcome = status.outcome ?? null;
    const added =
      status.state === "succeeded" && outcome?.kind === "added" ? outcome.ref : undefined;
    this.set({
      phase: status.state,
      failure: running ? null : (status.failure ?? null),
      step: running ? (status.phase ?? "preparing") : null,
      authorizeUrl: running ? (status.authorizeUrl ?? null) : null,
      pasteAccepted: running && status.pasteAccepted === true,
      outcome,
      endedAt: status.endedAt ?? null,
      submitting: false,
      pasteError: extra.pasteError ?? null,
      justAdded: added ?? this.snapshot.justAdded,
    });
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
      // Keep a paste error on screen until the next submit or the login moves on.
      if (id === this.attachId) {
        this.adopt(status, { pasteError: this.snapshot.pasteError });
      }
    } catch {
      if (id === this.attachId) this.fail("unreachable");
    }
  }

  private stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private set(patch: Partial<LoginSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}

export interface HostAccountLogin {
  snapshot: LoginSnapshot;
  /** The host can sign accounts in (macOS with routing). */
  featureOn: boolean;
  /** The host shows the sign-in link and accepts a pasted address (`ompAccountLoginLink`). */
  linkOn: boolean;
  /** This app is the desktop app and the host is the daemon on this same computer. */
  onHostComputer: boolean;
  start: () => void;
  cancel: () => void;
  submitCode: (input: string) => void;
  dismiss: () => void;
}

/** Add-account for one host. Mount with `key={serverId}` so hosts never share state. */
export function useHostAccountLogin(serverId: string): HostAccountLogin {
  const [controller] = useState(() => new AccountLoginController());
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const featureOn = useHostFeature(serverId, "ompAccountLogin");
  const linkOn = useHostFeature(serverId, "ompAccountLoginLink");
  const onHostComputer = useIsLocalDaemon(serverId);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);

  useEffect(() => {
    if (!client || !connected || !featureOn || !linkOn || !onHostComputer) return undefined;
    controller.attach(client);
    return () => controller.detach();
  }, [client, connected, controller, featureOn, linkOn, onHostComputer]);

  return {
    snapshot,
    featureOn,
    linkOn,
    onHostComputer,
    start: () => void controller.start(),
    cancel: () => void controller.cancel(),
    submitCode: (input) => void controller.submitCode(input),
    dismiss: () => controller.dismiss(),
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
