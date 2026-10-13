import { randomUUID } from "node:crypto";
import type {
  OmpAccountRoutingMutation,
  OmpAccountRoutingState,
  OmpRoutingAccount,
  OmpRoutingBlock,
  RoutingRefusalCode,
  RoutingWaitReason,
} from "@getpaseo/protocol/messages";
import { AccountRoutingStore, type PolicyDraft } from "./store.js";
import {
  AccountRoutingPersistenceError,
  ROUTING_ERROR_MESSAGES,
  compareRefs,
  refKey,
  sameRef,
  type AccountRoutingClock,
  type AccountRoutingErrorCode,
  type AdmissionDecision,
  type AdmissionRequest,
  type AttachRuntimeInput,
  type CancelReport,
  type OmpAccountRoutingPolicy,
  type OmpRoutingAccountRef,
  type OutcomeReport,
  type RankCandidatesResult,
  type RoutingCatalog,
  type RoutingCatalogAccount,
  type RoutingMetadataAdapter,
  type StartedReport,
} from "./types.js";

// Critical sections below are synchronous (the store commits with a sync atomic write), so JS
// run-to-completion is the serial policy queue. Only adapter calls (refresh, rank) are async, and
// they run between sections; results are applied only after rechecking the captured revisions.
// ponytail: if the store ever goes async, add a promise chain around mutate/admit sections.

const MAX_ADMISSION_PASSES = 8;
const MAX_TIMER_MS = 2 ** 31 - 1;

const LISTING_RUNTIME_ID = "host-listing";

const systemClock: AccountRoutingClock = {
  now: () => Date.now(),
  setTimer(callback, delayMs) {
    const handle = setTimeout(callback, Math.min(delayMs, MAX_TIMER_MS));
    handle.unref?.();
    return () => clearTimeout(handle);
  },
};

interface AccountRoutingMutateResult {
  state: OmpAccountRoutingState;
  error: null | { code: AccountRoutingErrorCode; message: string };
}

interface RuntimeEntry {
  input: AttachRuntimeInput;
  adapter: RoutingMetadataAdapter;
  catalogs: Map<string, RoutingCatalog>;
}

interface Binding {
  admissionId: string;
  runtimeInstanceId: string;
  agentId: string;
  sessionId: string;
  operationId: string;
  attemptId: string;
  model: string;
  ref: OmpRoutingAccountRef;
  selectionGeneration: number;
  phase: "admitted" | "serving";
  observedAt: number;
}

interface Wait {
  waitId: string;
  seq: number;
  runtimeInstanceId: string;
  agentId: string;
  sessionId: string;
  operationId: string;
  attemptId: string;
  model: string;
  reason: RoutingWaitReason;
  nextCheckAt: number | null;
  requiresUserAction: boolean;
  accountRef: OmpRoutingAccountRef | null;
  recoveredAt: number | null;
  /** Set once the wait re-admitted; the entry then stays only as a recovery marker. */
  admissionId: string | null;
  /** Wake hint already sent for the current due time. */
  hinted: boolean;
}

interface PendingAdmission {
  cancelled: boolean;
  controller: AbortController;
}

type Evaluation =
  | { kind: "usable" }
  | { kind: "refresh" }
  | { kind: "unavailable"; reason: RoutingRefusalCode }
  | { kind: "billing"; reason: "billing_enabled" | "billing_unknown" }
  | { kind: "entitlement" }
  | { kind: "blocked"; resetAt: number | null };

type Plan =
  | { kind: "done"; decision: AdmissionDecision }
  | { kind: "refresh"; ref: OmpRoutingAccountRef }
  | {
      kind: "rank";
      candidates: OmpRoutingAccountRef[];
      catalogRevision: number;
      policyRevision: number;
      selectionGeneration: number;
    };

export interface AccountRoutingAuthorityOptions {
  store: AccountRoutingStore;
  clock?: AccountRoutingClock;
  newId?: () => string;
}

function unknownBilling() {
  return {
    state: "unknown" as const,
    observedAt: null,
    validUntil: null,
    source: null,
    sourceRevision: null,
    reason: null,
  };
}

function unknownRank() {
  return {
    method: "claude-native-window-pressure-v1" as const,
    version: 1 as const,
    modelId: null,
    modelFamily: null,
    planGateApplies: false,
    planEligibility: "unknown" as const,
    billingEligibility: "unknown" as const,
    applicableLimitIds: [],
    coverage: "unknown" as const,
    unknownReasons: [],
    usageMeasured: false,
    primaryHot: null,
    primaryUsed: null,
    secondaryUsed: null,
    primaryRequiredDrain: null,
    secondaryRequiredDrain: null,
  };
}

function refusal(reason: RoutingRefusalCode, requiresUserAction = false): AdmissionDecision {
  return { kind: "refuse", reason, requiresUserAction };
}

function emptyEntry(ref: OmpRoutingAccountRef): RoutingCatalogAccount {
  return {
    ref,
    display: { email: null, accountId: null, organizationId: null, organizationName: null },
    credentialAvailable: false,
    quotaIdentity: null,
    billing: unknownBilling(),
    subscriptionTier: { kind: "unknown", observedAt: null, source: null },
    windows: [],
    quotaBlocks: [],
    rank: unknownRank(),
  };
}

function displayLabels(ref: OmpRoutingAccountRef, entry: RoutingCatalogAccount) {
  const d = entry.display;
  const label = d.email ?? d.accountId ?? `Account ${ref.nativeRowId}`;
  const organizationLabel = d.organizationName ?? d.organizationId ?? null;
  return {
    label,
    organizationLabel,
    pair: JSON.stringify([label, organizationLabel]),
    incomplete: !(d.email ?? d.accountId) || organizationLabel === null,
  };
}

function blockKey(block: OmpRoutingBlock): string {
  return JSON.stringify([block.limitId, block.scope]);
}

/** Later observation wins; at equal time the more restrictive block (null reset, then later reset). */
function moreAuthoritative(a: OmpRoutingBlock, b: OmpRoutingBlock): OmpRoutingBlock {
  if (a.observedAt !== b.observedAt) return a.observedAt > b.observedAt ? a : b;
  if (a.resetAt === null) return a;
  if (b.resetAt === null) return b;
  return a.resetAt >= b.resetAt ? a : b;
}

function mergeBlocks(...lists: OmpRoutingBlock[][]): OmpRoutingBlock[] {
  const merged = new Map<string, OmpRoutingBlock>();
  for (const block of lists.flat()) {
    const key = blockKey(block);
    const existing = merged.get(key);
    merged.set(key, existing ? moreAuthoritative(existing, block) : block);
  }
  return [...merged.values()];
}

function billingRestrictiveness(state: "enabled" | "unknown" | "disabled"): number {
  if (state === "enabled") return 2;
  return state === "unknown" ? 1 : 0;
}

export class AccountRoutingAuthority {
  readonly hostEpoch: string;
  private readonly store: AccountRoutingStore;
  private readonly clock: AccountRoutingClock;
  private readonly newId: () => string;
  private readonly runtimes = new Map<string, RuntimeEntry>();
  private readonly bindings = new Map<string, Binding>();
  private readonly waits = new Map<string, Wait>();
  private readonly pending = new Map<string, PendingAdmission>();
  private readonly lastServed = new Map<
    string,
    { accountRef: OmpRoutingAccountRef; model: string; servedAt: number }
  >();
  private readonly hostBlocks = new Map<string, OmpRoutingBlock[]>();
  private readonly observers = new Set<(state: OmpAccountRoutingState) => void>();
  /** Labels-only store listing no agent produced. Fills in rows no runtime catalog covers. */
  private listing: { source: "listing" | "login"; catalog: RoutingCatalog } | null = null;
  private listingRevision = 0;
  private sequence = 0;
  private waitSeq = 0;
  private lastBodyJson = "";
  private cancelTimer: (() => void) | null = null;
  private disposed = false;
  /** What the configured binary's probe said; used only while no runtime is attached. */
  private probedCapability: OmpAccountRoutingState["capability"] = {
    status: "unknown",
    reason: null,
  };

  constructor(options: AccountRoutingAuthorityOptions) {
    this.store = options.store;
    this.clock = options.clock ?? systemClock;
    this.newId = options.newId ?? randomUUID;
    this.hostEpoch = this.newId();
  }

  // ---- public surface -------------------------------------------------------------------

  snapshot(): OmpAccountRoutingState {
    this.publish();
    return this.buildState();
  }

  async observe(
    onState: (state: OmpAccountRoutingState) => void,
  ): Promise<{ state: OmpAccountRoutingState; release: () => void }> {
    const state = this.snapshot();
    this.observers.add(onState);
    return { state, release: () => void this.observers.delete(onState) };
  }

  async mutate(input: {
    expectedPolicyRevision: number;
    command: OmpAccountRoutingMutation;
  }): Promise<AccountRoutingMutateResult> {
    const fail = (code: AccountRoutingErrorCode): AccountRoutingMutateResult => ({
      state: this.snapshot(),
      error: { code, message: ROUTING_ERROR_MESSAGES[code] },
    });
    if (this.capability().status === "unsupported") return fail("unsupported");
    const policy = this.store.policy;
    if (input.expectedPolicyRevision !== policy.policyRevision) return fail("conflict");

    const { command } = input;
    if ("account" in command && !this.isKnown(command.account, policy))
      return fail("invalid_account");

    const draft = this.withDefaults(policy, "account" in command ? [command.account] : []);
    let newSelection = false;
    let wake: "all" | "eligible" | null = null;
    if (command.kind === "select") {
      draft.current = command.account;
      newSelection = true;
      wake = "all";
    } else if (command.kind === "set_auto") {
      draft.autoEnabled = command.enabled;
      wake = command.enabled ? "all" : null;
    } else if (command.kind === "set_inclusion") {
      const entry = draft.inclusion.find((e) => sameRef(e.account, command.account));
      if (entry) entry.included = command.included;
      wake = "eligible";
    } else {
      this.movePriority(draft, command.account, command.direction);
    }

    try {
      const result = this.store.commit(policy.policyRevision, draft, { newSelection });
      if (result.kind === "committed" && wake)
        this.wake(wake === "all" ? () => true : (w) => !w.requiresUserAction);
      return { state: this.snapshot(), error: null };
    } catch (error) {
      if (error instanceof AccountRoutingPersistenceError) return fail("persistence_failed");
      throw error;
    }
  }

  /**
   * The ref of a row a host sign-in just wrote, when the host knows exactly one OMP store. The
   * login child reports a bare native row id; with no or several known stores this refuses to guess.
   */
  refForSignedInRow(nativeRowId: number): OmpRoutingAccountRef | null {
    const storeNamespace = this.singleNamespace();
    return storeNamespace ? { storeNamespace, nativeRowId } : null;
  }

  private singleNamespace(): string | null {
    const policy = this.store.policy;
    const namespaces = new Set<string>();
    for (const r of policy.priorityOrder) namespaces.add(r.storeNamespace);
    for (const e of policy.inclusion) namespaces.add(e.account.storeNamespace);
    if (policy.current) namespaces.add(policy.current.storeNamespace);
    for (const { entry } of this.views().values()) namespaces.add(entry.ref.storeNamespace);
    return namespaces.size === 1 ? [...namespaces][0] : null;
  }

  /**
   * Keeps OMP's own store listing (ids and labels, read with no token refresh) so rows show without
   * a running agent. It is never authoritative: windows, billing and tier stay unknown, it cannot
   * mark a row missing, it never reaches admission, and any runtime catalog for a row wins.
   * Returns false when the store namespace is not known exactly, so nothing is invented.
   */
  publishListing(
    source: "listing" | "login",
    rows: ReadonlyArray<{ nativeRowId: number; label: string }>,
  ): boolean {
    const storeNamespace = this.singleNamespace();
    if (this.disposed || !storeNamespace) return false;
    const accounts = rows.map(({ nativeRowId, label }) => {
      const entry = emptyEntry({ storeNamespace, nativeRowId });
      return { ...entry, display: { ...entry.display, email: label }, credentialAvailable: true };
    });
    this.listingRevision += 1;
    this.listing = {
      source,
      catalog: {
        provider: "anthropic",
        runtimeInstanceId: LISTING_RUNTIME_ID,
        storeNamespace,
        catalogRevision: this.listingRevision,
        nativeCredentialGeneration: 0,
        observedAt: this.clock.now(),
        authoritativeObservedAt: null,
        authoritativeComplete: false,
        accounts,
      },
    };
    this.publish();
    return true;
  }

  /**
   * Lists a newly signed-in account now, before any runtime reports it: the same default-adding
   * commit a new catalog identity gets (end of priority, included, never selected; D3, D5).
   */
  addSignedInAccount(ref: OmpRoutingAccountRef): void {
    if (this.disposed) return;
    const policy = this.store.policy;
    const draft = this.withDefaults(policy, [ref]);
    if (draft.priorityOrder.length === policy.priorityOrder.length) return;
    try {
      this.store.commit(policy.policyRevision, draft);
    } catch (error) {
      if (!(error instanceof AccountRoutingPersistenceError)) throw error;
      // The next catalog that lists the row retries the same default commit.
    }
    this.publish();
  }

  /** Startup probe of the configured OMP binary. Running agents take over once they attach. */
  setProbedCapability(capability: OmpAccountRoutingState["capability"]): void {
    if (this.disposed) return;
    this.probedCapability = capability;
    this.publish();
  }

  attachRuntime(input: AttachRuntimeInput, adapter: RoutingMetadataAdapter): { dispose(): void } {
    this.detachRuntime(input.runtimeInstanceId);
    this.runtimes.set(input.runtimeInstanceId, { input, adapter, catalogs: new Map() });
    for (const catalog of adapter.catalogSnapshot()) this.ingest(input.runtimeInstanceId, catalog);
    this.publish();
    return { dispose: () => this.detachRuntime(input.runtimeInstanceId) };
  }

  publishCatalog(runtimeInstanceId: string, catalog: RoutingCatalog): void {
    this.ingest(runtimeInstanceId, catalog);
    this.publish();
  }

  /** Metadata-only admission. Never opens a credential; refresh and rank go through the adapter. */
  async admit(request: AdmissionRequest): Promise<AdmissionDecision> {
    const pendingKey = `${request.runtimeInstanceId}|${request.operationId}|${request.attemptId}`;
    const pending: PendingAdmission = { cancelled: false, controller: new AbortController() };
    this.pending.set(pendingKey, pending);
    const onAbort = () => {
      pending.cancelled = true;
      pending.controller.abort();
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });
    if (request.signal?.aborted) onAbort();
    try {
      const decision = await this.admitLoop(request, pending);
      // A refusal ends the continuation, so its previous wait is retired with it.
      if (decision.kind === "refuse" && request.previousWaitId)
        this.waits.delete(request.previousWaitId);
      return decision;
    } finally {
      request.signal?.removeEventListener("abort", onAbort);
      this.pending.delete(pendingKey);
      this.publish();
    }
  }

  started(report: StartedReport): void {
    const binding = this.bindings.get(report.admissionId);
    if (!binding || binding.runtimeInstanceId !== report.runtimeInstanceId) return;
    binding.phase = "serving";
    const previous = this.lastServed.get(binding.agentId);
    if (!previous || report.startedAt >= previous.servedAt) {
      this.lastServed.set(binding.agentId, {
        accountRef: binding.ref,
        model: binding.model,
        servedAt: report.startedAt,
      });
    }
    this.publish();
  }

  /** Settles a binding once. Records the confirmed scope on the serving account only. */
  outcome(report: OutcomeReport): void {
    const binding = this.bindings.get(report.admissionId);
    if (!binding || binding.runtimeInstanceId !== report.runtimeInstanceId) return;
    if (report.hostEpoch !== this.hostEpoch || !sameRef(binding.ref, report.accountRef)) return;
    this.bindings.delete(report.admissionId);
    this.dropRecoveredMarkers(report.admissionId);
    if (report.quotaBlocks.length > 0) {
      const key = refKey(binding.ref);
      this.hostBlocks.set(key, mergeBlocks(this.hostBlocks.get(key) ?? [], report.quotaBlocks));
    }
    this.publish();
  }

  /** Idempotent. Removes the wait before any wake can reach it. */
  cancel(report: CancelReport): void {
    const pending = this.pending.get(
      `${report.runtimeInstanceId}|${report.operationId}|${report.attemptId}`,
    );
    if (pending) {
      pending.cancelled = true;
      pending.controller.abort();
    }
    for (const wait of this.waits.values()) {
      if (wait.runtimeInstanceId !== report.runtimeInstanceId) continue;
      if (
        wait.waitId === report.waitId ||
        (wait.operationId === report.operationId && wait.admissionId === null)
      ) {
        this.waits.delete(wait.waitId);
      }
    }
    if (report.admissionId) {
      const binding = this.bindings.get(report.admissionId);
      if (binding?.runtimeInstanceId === report.runtimeInstanceId)
        this.bindings.delete(report.admissionId);
      this.dropRecoveredMarkers(report.admissionId);
    }
    this.rearmTimer();
    this.publish();
  }

  /** Host agent archived or disposed: drop its transient work and last-served record. */
  disposeAgent(agentId: string): void {
    for (const [id, binding] of this.bindings)
      if (binding.agentId === agentId) this.bindings.delete(id);
    for (const [id, wait] of this.waits) if (wait.agentId === agentId) this.waits.delete(id);
    this.lastServed.delete(agentId);
    this.rearmTimer();
    this.publish();
  }

  snapshotForAgent(agentId: string) {
    const state = this.snapshot();
    const activeRequests = state.activeRequests.filter((r) => r.agentId === agentId);
    const lastServed = state.lastServed.filter((r) => r.agentId === agentId);
    return {
      hostEpoch: state.hostEpoch,
      stateSequence: state.stateSequence,
      accounts: state.accounts,
      activeRequests,
      lastServed,
    };
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTimer?.();
    this.cancelTimer = null;
    for (const pending of this.pending.values()) {
      pending.cancelled = true;
      pending.controller.abort();
    }
    this.runtimes.clear();
    this.listing = null;
    this.bindings.clear();
    this.waits.clear();
    this.lastServed.clear();
    this.observers.clear();
  }

  // ---- state ------------------------------------------------------------------------------

  private capability(): OmpAccountRoutingState["capability"] {
    const runtimes = [...this.runtimes.values()];
    if (runtimes.length === 0) return this.probedCapability;
    if (
      runtimes.some(
        (r) =>
          r.input.capabilityVersion !== null &&
          (r.input.capabilityVersion !== 1 || r.input.completeCoverage === false),
      )
    ) {
      return { status: "unsupported", reason: "unsupported_runtime" };
    }
    if (
      runtimes.some((r) => r.input.capabilityVersion === null || r.input.completeCoverage === null)
    ) {
      return { status: "unknown", reason: null };
    }
    return { status: "supported", reason: null };
  }

  /** Best observation per ref across runtimes: newest catalog, conservative billing on a tie. */
  private views(): Map<string, { entry: RoutingCatalogAccount; catalog: RoutingCatalog }> {
    const best = new Map<string, { entry: RoutingCatalogAccount; catalog: RoutingCatalog }>();
    for (const runtime of this.runtimes.values()) {
      for (const catalog of runtime.catalogs.values()) {
        for (const entry of catalog.accounts) {
          const key = refKey(entry.ref);
          const held = best.get(key);
          const wins =
            !held ||
            catalog.observedAt > held.catalog.observedAt ||
            (catalog.observedAt === held.catalog.observedAt &&
              billingRestrictiveness(entry.billing.state) >
                billingRestrictiveness(held.entry.billing.state));
          if (wins) best.set(key, { entry, catalog });
        }
      }
    }
    return best;
  }

  /** What the app may show: runtime views, plus listing rows no runtime catalog covers. */
  private displayViews(): Map<string, { entry: RoutingCatalogAccount; catalog: RoutingCatalog }> {
    const best = this.views();
    if (this.listing) {
      for (const entry of this.listing.catalog.accounts) {
        if (!best.has(refKey(entry.ref)))
          best.set(refKey(entry.ref), { entry, catalog: this.listing.catalog });
      }
    }
    return best;
  }

  /** Refs confirmed absent: newest complete catalog per namespace; equal-time disagreement is unknown. */
  private confirmedAbsent(): { present: Map<string, Set<string>>; newest: Map<string, number> } {
    const newest = new Map<string, number>();
    const present = new Map<string, Set<string>>();
    const conflicted = new Set<string>();
    for (const runtime of this.runtimes.values()) {
      for (const catalog of runtime.catalogs.values()) {
        if (!catalog.authoritativeComplete || catalog.authoritativeObservedAt === null) continue;
        const ns = catalog.storeNamespace;
        const at = catalog.authoritativeObservedAt;
        const refs = new Set(catalog.accounts.map((a) => refKey(a.ref)));
        const heldAt = newest.get(ns);
        if (heldAt === undefined || at > heldAt) {
          newest.set(ns, at);
          present.set(ns, refs);
          conflicted.delete(ns);
        } else if (at === heldAt) {
          const held = present.get(ns)!;
          if (held.size !== refs.size || [...refs].some((k) => !held.has(k))) conflicted.add(ns);
        }
      }
    }
    for (const ns of conflicted) present.delete(ns);
    return { present, newest };
  }

  private buildState(): OmpAccountRoutingState {
    const policy = this.store.policy;
    const capability = this.capability();
    return {
      hostEpoch: this.hostEpoch,
      stateSequence: this.sequence,
      policy,
      capability,
      catalog: this.catalogSummary(capability),
      accounts: this.buildAccounts(policy),
      activeRequests: Array.from(this.bindings.values(), (b) => ({
        admissionId: b.admissionId,
        agentId: b.agentId,
        nativeSessionId: b.sessionId,
        model: b.model,
        accountRef: b.ref,
        selectionGeneration: b.selectionGeneration,
        phase: b.phase,
        observedAt: b.observedAt,
      })),
      lastServed: Array.from(this.lastServed.entries(), ([agentId, v]) => ({
        agentId,
        accountRef: v.accountRef,
        model: v.model,
        servedAt: v.servedAt,
      })),
      pausedRequests: Array.from(this.waits.values())
        .sort((a, b) => a.seq - b.seq)
        .map((w) => ({
          waitId: w.waitId,
          agentId: w.agentId,
          nativeSessionId: w.sessionId,
          model: w.model,
          reason: w.reason,
          nextCheckAt: w.nextCheckAt,
          requiresUserAction: w.requiresUserAction,
          accountRef: w.accountRef,
          recoveredAt: w.recoveredAt,
        })),
    };
  }

  private catalogSummary(
    capability: OmpAccountRoutingState["capability"],
  ): OmpAccountRoutingState["catalog"] {
    const catalogs: RoutingCatalog[] = [];
    for (const runtime of this.runtimes.values()) catalogs.push(...runtime.catalogs.values());
    if (this.listing) catalogs.push(this.listing.catalog);
    const complete = catalogs.filter((c) => c.authoritativeComplete);
    let authoritativeObservedAt: number | null = null;
    for (const c of complete) {
      const at = c.authoritativeObservedAt;
      if (at !== null && (authoritativeObservedAt === null || at > authoritativeObservedAt)) {
        authoritativeObservedAt = at;
      }
    }
    if (capability.status === "unsupported")
      return { status: "unsupported", authoritativeObservedAt };
    if (catalogs.length === 0) return { status: "loading", authoritativeObservedAt };
    if (complete.length === 0) return { status: "incomplete", authoritativeObservedAt };
    const loaded = complete.some((c) => c.accounts.length > 0);
    return { status: loaded ? "loaded" : "empty", authoritativeObservedAt };
  }

  private orderedRefs(policy: OmpAccountRoutingPolicy): OmpRoutingAccountRef[] {
    const refs = new Map<string, OmpRoutingAccountRef>();
    for (const ref of policy.priorityOrder) refs.set(refKey(ref), ref);
    for (const { entry } of this.displayViews().values()) {
      if (!refs.has(refKey(entry.ref))) refs.set(refKey(entry.ref), entry.ref);
    }
    if (policy.current && !refs.has(refKey(policy.current))) {
      refs.set(refKey(policy.current), policy.current);
    }
    const rank = (r: OmpRoutingAccountRef) => {
      const i = policy.priorityOrder.findIndex((p) => sameRef(p, r));
      return i < 0 ? Number.POSITIVE_INFINITY : i;
    };
    return Array.from(refs.values()).sort((a, b) => rank(a) - rank(b) || compareRefs(a, b));
  }

  /** Labels follow host D14: email, then account UUID, then Account+row; ns:row when ambiguous. */
  private buildAccounts(policy: OmpAccountRoutingPolicy): OmpRoutingAccount[] {
    const views = this.displayViews();
    const { present, newest } = this.confirmedAbsent();
    const rows = this.orderedRefs(policy).map((ref) => {
      const view = views.get(refKey(ref));
      const entry = view?.entry ?? emptyEntry(ref);
      return { ref, entry, labels: displayLabels(ref, entry), catalog: view?.catalog };
    });
    const pairCount = new Map<string, number>();
    for (const { labels } of rows) {
      pairCount.set(labels.pair, (pairCount.get(labels.pair) ?? 0) + 1);
    }
    return rows.map(({ ref, entry, labels, catalog }) => {
      const namespaceRefs = present.get(ref.storeNamespace);
      const missing = namespaceRefs !== undefined && !namespaceRefs.has(refKey(ref));
      const ambiguous = (pairCount.get(labels.pair) ?? 0) > 1 || labels.incomplete;
      const full = `${ref.storeNamespace}:${ref.nativeRowId}`;
      return {
        ref,
        label: labels.label,
        organizationLabel: labels.organizationLabel,
        identityLabel: ambiguous ? full : (entry.display.accountId ?? full),
        organizationIdentityLabel: ambiguous ? full : (entry.display.organizationId ?? full),
        available: !missing && entry.credentialAvailable,
        missing,
        authoritativeObservedAt:
          catalog?.authoritativeObservedAt ?? newest.get(ref.storeNamespace) ?? null,
        quotaIdentity: entry.quotaIdentity,
        subscriptionTier: entry.subscriptionTier,
        absoluteAllowance: null,
        windows: entry.windows,
        billing: entry.billing,
        rank: entry.rank,
        quotaBlocks: mergeBlocks(entry.quotaBlocks, this.hostBlocks.get(refKey(ref)) ?? []),
        rankingCoverage: entry.rank.coverage,
      };
    });
  }

  /** Bumps stateSequence only when the visible state changed, then notifies observers off-stack. */
  private publish(): void {
    if (this.disposed) return;
    const { stateSequence: _ignored, ...body } = this.buildState();
    const json = JSON.stringify(body);
    if (json === this.lastBodyJson) return;
    this.lastBodyJson = json;
    this.sequence += 1;
    const state = this.buildState();
    for (const observer of this.observers)
      queueMicrotask(() => this.observers.has(observer) && observer(state));
  }

  // ---- policy helpers -----------------------------------------------------------------------

  private isKnown(ref: OmpRoutingAccountRef, policy: OmpAccountRoutingPolicy): boolean {
    return (
      policy.priorityOrder.some((r) => sameRef(r, ref)) ||
      sameRef(policy.current, ref) ||
      this.displayViews().has(refKey(ref))
    );
  }

  /** Draft with every catalog ref plus `extra` present in order/inclusion (default included, stable order). */
  private withDefaults(
    policy: OmpAccountRoutingPolicy,
    extra: OmpRoutingAccountRef[],
  ): PolicyDraft {
    const { policyRevision: _r, selectionGeneration: _g, ...rest } = structuredClone(policy);
    const draft: PolicyDraft = rest;
    const fresh = new Map<string, OmpRoutingAccountRef>();
    for (const { entry } of this.views().values()) fresh.set(refKey(entry.ref), entry.ref);
    for (const ref of extra) fresh.set(refKey(ref), ref);
    for (const ref of [...fresh.values()].sort(compareRefs)) {
      if (!draft.priorityOrder.some((r) => sameRef(r, ref))) draft.priorityOrder.push(ref);
      if (!draft.inclusion.some((e) => sameRef(e.account, ref)))
        draft.inclusion.push({ account: ref, included: true });
    }
    return draft;
  }

  private movePriority(
    draft: PolicyDraft,
    ref: OmpRoutingAccountRef,
    direction: "up" | "down",
  ): void {
    const views = this.displayViews();
    const { present } = this.confirmedAbsent();
    const isPresent = (r: OmpRoutingAccountRef) =>
      views.has(refKey(r)) &&
      !(present.get(r.storeNamespace) && !present.get(r.storeNamespace)!.has(refKey(r)));
    const order = draft.priorityOrder;
    const index = order.findIndex((r) => sameRef(r, ref));
    const step = direction === "up" ? -1 : 1;
    for (let j = index + step; j >= 0 && j < order.length; j += step) {
      if (isPresent(order[j])) {
        [order[index], order[j]] = [order[j], order[index]];
        return;
      }
    }
  }

  private isIncluded(policy: OmpAccountRoutingPolicy, ref: OmpRoutingAccountRef): boolean {
    return policy.inclusion.find((e) => sameRef(e.account, ref))?.included ?? true;
  }

  // ---- catalogs -------------------------------------------------------------------------------

  private ingest(runtimeInstanceId: string, catalog: RoutingCatalog): void {
    const runtime = this.runtimes.get(runtimeInstanceId);
    if (!runtime || catalog.runtimeInstanceId !== runtimeInstanceId) return;
    const held = runtime.catalogs.get(catalog.storeNamespace);
    if (held && catalog.catalogRevision <= held.catalogRevision) return;
    // An authoritative read older than the held one cannot rewrite which identities exist.
    if (
      held?.authoritativeComplete &&
      held.authoritativeObservedAt !== null &&
      catalog.authoritativeObservedAt !== null &&
      catalog.authoritativeObservedAt < held.authoritativeObservedAt
    ) {
      return;
    }
    runtime.catalogs.set(catalog.storeNamespace, catalog);

    // A fresh post-reset observation retires host-only blocks for that account.
    for (const account of catalog.accounts) {
      const key = refKey(account.ref);
      const blocks = this.hostBlocks.get(key);
      if (!blocks) continue;
      const kept = blocks.filter((b) => b.resetAt === null || catalog.observedAt <= b.resetAt);
      if (kept.length === 0) this.hostBlocks.delete(key);
      else this.hostBlocks.set(key, kept);
    }

    // Reconcile new native identities into policy as one default-adding commit; never selects.
    const policy = this.store.policy;
    const draft = this.withDefaults(policy, []);
    if (draft.priorityOrder.length !== policy.priorityOrder.length) {
      try {
        this.store.commit(policy.policyRevision, draft);
      } catch (error) {
        if (!(error instanceof AccountRoutingPersistenceError)) throw error;
        // Defaults stay in memory only through withDefaults; the next mutation retries the write.
      }
    }

    const changed = !held || JSON.stringify(held.accounts) !== JSON.stringify(catalog.accounts);
    if (changed) this.wake((w) => !w.requiresUserAction);
  }

  private detachRuntime(runtimeInstanceId: string): void {
    if (!this.runtimes.delete(runtimeInstanceId)) return;
    const agents = new Set<string>();
    for (const [id, b] of this.bindings) {
      if (b.runtimeInstanceId === runtimeInstanceId) {
        agents.add(b.agentId);
        this.bindings.delete(id);
      }
    }
    for (const [id, w] of this.waits) {
      if (w.runtimeInstanceId === runtimeInstanceId) {
        agents.add(w.agentId);
        this.waits.delete(id);
      }
    }
    for (const [key, pending] of this.pending) {
      if (key.startsWith(`${runtimeInstanceId}|`)) {
        pending.cancelled = true;
        pending.controller.abort();
      }
    }
    for (const agentId of agents) this.lastServed.delete(agentId);
    this.rearmTimer();
    this.publish();
  }

  // ---- admission --------------------------------------------------------------------------------

  private async admitLoop(
    request: AdmissionRequest,
    pending: PendingAdmission,
  ): Promise<AdmissionDecision> {
    if (request.previousWaitId) {
      const previous = this.waits.get(request.previousWaitId);
      const live =
        previous?.runtimeInstanceId === request.runtimeInstanceId && previous.admissionId === null;
      if (!live) return { kind: "refuse", reason: "cancelled", requiresUserAction: false };
    }
    const refreshed = new Set<string>();
    for (let pass = 0; pass < MAX_ADMISSION_PASSES; pass += 1) {
      const runtime = this.runtimes.get(request.runtimeInstanceId);
      if (this.disposed || !runtime) return refusal("host_unavailable");
      if (pending.cancelled) return refusal("cancelled");
      if (pass === 0 && request.catalog) this.ingest(request.runtimeInstanceId, request.catalog);

      const plan = this.plan(request, runtime, refreshed);
      if (plan.kind === "done") return plan.decision;
      if (plan.kind === "refresh") {
        refreshed.add(refKey(plan.ref));
        await this.refreshRow(request, runtime, plan.ref, pending);
        continue;
      }
      // null means the proposal went stale; plan again against the current policy.
      const decision = await this.rankAndSelect(request, runtime, plan, pending);
      if (decision) return decision;
    }
    return refusal("host_unavailable");
  }

  private async refreshRow(
    request: AdmissionRequest,
    runtime: RuntimeEntry,
    ref: OmpRoutingAccountRef,
    pending: PendingAdmission,
  ): Promise<void> {
    try {
      const catalog = await runtime.adapter.refreshMetadata(
        ref,
        request.modelId,
        pending.controller.signal,
      );
      this.ingest(request.runtimeInstanceId, catalog);
    } catch {
      // Typed unknown: the row stays unsafe and is refused, never treated as exhausted.
    }
  }

  private async rankAndSelect(
    request: AdmissionRequest,
    runtime: RuntimeEntry,
    plan: Extract<Plan, { kind: "rank" }>,
    pending: PendingAdmission,
  ): Promise<AdmissionDecision | null> {
    let ranked: RankCandidatesResult;
    try {
      ranked = await runtime.adapter.rankCandidates(
        {
          candidateRefs: plan.candidates,
          modelId: request.modelId,
          catalogRevision: plan.catalogRevision,
          nowMs: this.clock.now(),
        },
        pending.controller.signal,
      );
    } catch {
      return pending.cancelled ? refusal("cancelled") : refusal("source_changed", true);
    }
    if (pending.cancelled) return refusal("cancelled");
    const policy = this.store.policy;
    const liveRevision = runtime.catalogs.get(plan.candidates[0].storeNamespace)?.catalogRevision;
    const stale =
      policy.policyRevision !== plan.policyRevision ||
      policy.selectionGeneration !== plan.selectionGeneration ||
      this.runtimes.get(request.runtimeInstanceId) !== runtime ||
      liveRevision !== plan.catalogRevision ||
      ranked.catalogRevision !== plan.catalogRevision;
    if (stale) return null;
    const allowed = ranked.bestCloseRefs.filter((r) => plan.candidates.some((c) => sameRef(c, r)));
    if (allowed.length === 0 || allowed.length !== ranked.bestCloseRefs.length) {
      return refusal("source_changed", true);
    }
    return this.selectAndAdmit(request, runtime, policy, this.pickByPriority(allowed, policy));
  }

  private pickByPriority(
    refs: OmpRoutingAccountRef[],
    policy: OmpAccountRoutingPolicy,
  ): OmpRoutingAccountRef {
    const rank = (r: OmpRoutingAccountRef) => {
      const i = policy.priorityOrder.findIndex((p) => sameRef(p, r));
      return i < 0 ? Number.POSITIVE_INFINITY : i;
    };
    return [...refs].sort((a, b) => rank(a) - rank(b) || compareRefs(a, b))[0];
  }

  private evaluate(
    ref: OmpRoutingAccountRef,
    modelId: string,
    now: number,
    refreshed: Set<string>,
  ): Evaluation {
    const view = this.views().get(refKey(ref));
    const { present } = this.confirmedAbsent();
    const confirmedMissing =
      present.get(ref.storeNamespace) && !present.get(ref.storeNamespace)!.has(refKey(ref));
    if (confirmedMissing) return { kind: "unavailable", reason: "no_account" };
    const done = refreshed.has(refKey(ref));
    if (!view) return done ? { kind: "unavailable", reason: "no_account" } : { kind: "refresh" };
    const { entry } = view;
    if (!entry.credentialAvailable) return { kind: "unavailable", reason: "auth_unavailable" };

    const billingFresh =
      entry.billing.state === "disabled" &&
      entry.billing.validUntil !== null &&
      entry.billing.validUntil > now;
    if (!billingFresh) {
      if (!done) return { kind: "refresh" };
      return {
        kind: "billing",
        reason: entry.billing.state === "enabled" ? "billing_enabled" : "billing_unknown",
      };
    }

    const rank = entry.rank;
    if (
      rank.modelId === modelId &&
      (rank.planEligibility === false ||
        (rank.planGateApplies && rank.planEligibility === "unknown"))
    ) {
      return { kind: "entitlement" };
    }

    const applicable = mergeBlocks(
      entry.quotaBlocks,
      this.hostBlocks.get(refKey(ref)) ?? [],
    ).filter(
      (b) =>
        b.scope.kind === "shared" ||
        (b.scope.kind === "model" && b.scope.modelId === modelId) ||
        (b.scope.kind === "family" && b.scope.family === rank.modelFamily),
    );
    if (applicable.length > 0) {
      if (!done && applicable.some((b) => b.resetAt !== null && b.resetAt <= now))
        return { kind: "refresh" };
      if (applicable.some((b) => b.resetAt === null || b.resetAt <= now))
        return { kind: "blocked", resetAt: null };
      return { kind: "blocked", resetAt: Math.min(...applicable.map((b) => b.resetAt!)) };
    }
    return { kind: "usable" };
  }

  private candidatesFor(
    runtime: RuntimeEntry,
    policy: OmpAccountRoutingPolicy,
  ): OmpRoutingAccountRef[] {
    const refs = new Map<string, OmpRoutingAccountRef>();
    for (const ref of policy.priorityOrder) refs.set(refKey(ref), ref);
    const rest: OmpRoutingAccountRef[] = [];
    for (const { entry } of this.views().values())
      if (!refs.has(refKey(entry.ref))) rest.push(entry.ref);
    return [...refs.values(), ...rest.sort(compareRefs)].filter(
      (ref) =>
        !sameRef(ref, policy.current) &&
        this.isIncluded(policy, ref) &&
        runtime.input.accessibleNamespaces.includes(ref.storeNamespace),
    );
  }

  private plan(request: AdmissionRequest, runtime: RuntimeEntry, refreshed: Set<string>): Plan {
    const now = this.clock.now();
    const policy = this.store.policy;
    const refuse = (reason: RoutingRefusalCode, requiresUserAction = true): Plan => ({
      kind: "done",
      decision: { kind: "refuse", reason, requiresUserAction },
    });
    const evals: Evaluation[] = [];

    const current = policy.current;
    if (current) {
      if (!runtime.input.accessibleNamespaces.includes(current.storeNamespace))
        return refuse("source_inaccessible");
      const ev = this.evaluate(current, request.modelId, now, refreshed);
      if (ev.kind === "usable")
        return this.decide(this.admitDecision(request, runtime, policy, current));
      if (ev.kind === "refresh") return { kind: "refresh", ref: current };
      if (ev.kind === "billing") return refuse(ev.reason);
      evals.push(ev);
      if (!policy.autoEnabled) {
        if (ev.kind === "blocked") {
          if (ev.resetAt === null) return refuse("quota_blocked");
          return this.waitPlan(request, runtime, "auto_disabled", null, true, current);
        }
        if (ev.kind === "entitlement") return refuse("entitlement_unavailable");
        return refuse(ev.kind === "unavailable" ? ev.reason : "no_account");
      }
    } else if (!policy.autoEnabled) {
      return refuse("no_account");
    }

    // Auto on and the current account cannot serve: choose a destination from included candidates.
    const candidates = this.candidatesFor(runtime, policy);
    const candidateEvals = candidates.map((ref) => ({
      ref,
      ev: this.evaluate(ref, request.modelId, now, refreshed),
    }));
    const usable = candidateEvals.filter((c) => c.ev.kind === "usable").map((c) => c.ref);
    if (usable.length === 0) {
      const cold = candidateEvals.find((c) => c.ev.kind === "refresh");
      if (cold) return { kind: "refresh", ref: cold.ref };
      evals.push(...candidateEvals.map((c) => c.ev));
      return this.noDestination(request, runtime, evals, current);
    }
    if (usable.length === 1) return this.selectPlan(request, runtime, policy, usable[0]);

    const namespaces = new Set(usable.map((r) => r.storeNamespace));
    const catalog =
      namespaces.size === 1 ? runtime.catalogs.get(usable[0].storeNamespace) : undefined;
    if (!catalog) return refuse("unsupported_runtime");
    return {
      kind: "rank",
      candidates: usable,
      catalogRevision: catalog.catalogRevision,
      policyRevision: policy.policyRevision,
      selectionGeneration: policy.selectionGeneration,
    };
  }

  private noDestination(
    request: AdmissionRequest,
    runtime: RuntimeEntry,
    evals: Evaluation[],
    current: OmpRoutingAccountRef | null,
  ): Plan {
    const resets = evals.flatMap((e) =>
      e.kind === "blocked" && e.resetAt !== null ? [e.resetAt] : [],
    );
    if (resets.length > 0)
      return this.waitPlan(
        request,
        runtime,
        "all_unavailable",
        Math.min(...resets),
        false,
        current,
      );
    const reason: RoutingRefusalCode = evals.some((e) => e.kind === "blocked")
      ? "quota_blocked"
      : ((evals.find((e) => e.kind === "billing") as { reason: RoutingRefusalCode } | undefined)
          ?.reason ??
        (evals.some((e) => e.kind === "entitlement") ? "entitlement_unavailable" : "no_account"));
    return { kind: "done", decision: { kind: "refuse", reason, requiresUserAction: true } };
  }

  private selectPlan(
    request: AdmissionRequest,
    runtime: RuntimeEntry,
    policy: OmpAccountRoutingPolicy,
    chosen: OmpRoutingAccountRef,
  ): Plan {
    return this.decide(this.selectAndAdmit(request, runtime, policy, chosen));
  }

  private decide(decision: AdmissionDecision): Plan {
    return { kind: "done", decision };
  }

  /** Persists the automatic choice before granting; a failed write refuses and leaves policy as it was. */
  private selectAndAdmit(
    request: AdmissionRequest,
    runtime: RuntimeEntry,
    policy: OmpAccountRoutingPolicy,
    chosen: OmpRoutingAccountRef,
  ): AdmissionDecision {
    try {
      const draft = this.withDefaults(policy, [chosen]);
      draft.current = chosen;
      const result = this.store.commit(policy.policyRevision, draft);
      if (result.kind === "conflict")
        return { kind: "refuse", reason: "host_unavailable", requiresUserAction: false };
      return this.admitDecision(request, runtime, result.policy, chosen);
    } catch (error) {
      if (error instanceof AccountRoutingPersistenceError) {
        return { kind: "refuse", reason: "persistence_failed", requiresUserAction: true };
      }
      throw error;
    }
  }

  private admitDecision(
    request: AdmissionRequest,
    runtime: RuntimeEntry,
    policy: OmpAccountRoutingPolicy,
    ref: OmpRoutingAccountRef,
  ): AdmissionDecision {
    const now = this.clock.now();
    const admissionId = this.newId();
    this.bindings.set(admissionId, {
      admissionId,
      runtimeInstanceId: request.runtimeInstanceId,
      agentId: runtime.input.agentId,
      sessionId: request.sessionId,
      operationId: request.operationId,
      attemptId: request.attemptId,
      model: request.modelId,
      ref,
      selectionGeneration: policy.selectionGeneration,
      phase: "admitted",
      observedAt: now,
    });
    const previous = request.previousWaitId ? this.waits.get(request.previousWaitId) : undefined;
    if (previous) {
      previous.recoveredAt = now;
      previous.admissionId = admissionId;
      this.rearmTimer();
    }
    return {
      kind: "admit",
      admissionId,
      accountRef: ref,
      selectionGeneration: policy.selectionGeneration,
      policyRevision: policy.policyRevision,
    };
  }

  private waitPlan(
    request: AdmissionRequest,
    runtime: RuntimeEntry,
    reason: RoutingWaitReason,
    nextCheckAt: number | null,
    requiresUserAction: boolean,
    accountRef: OmpRoutingAccountRef | null,
  ): Plan {
    const previous = request.previousWaitId ? this.waits.get(request.previousWaitId) : undefined;
    if (previous) this.waits.delete(previous.waitId);
    const waitId = this.newId();
    this.waits.set(waitId, {
      waitId,
      seq: previous?.seq ?? ++this.waitSeq,
      runtimeInstanceId: request.runtimeInstanceId,
      agentId: runtime.input.agentId,
      sessionId: request.sessionId,
      operationId: request.operationId,
      attemptId: request.attemptId,
      model: request.modelId,
      reason,
      nextCheckAt,
      requiresUserAction,
      accountRef,
      recoveredAt: null,
      admissionId: null,
      hinted: false,
    });
    this.rearmTimer();
    return {
      kind: "done",
      decision: {
        kind: "wait",
        waitId,
        reason,
        ...(nextCheckAt !== null ? { reconsiderAt: nextCheckAt } : {}),
        requiresUserAction,
      },
    };
  }

  // ---- waits and wake hints -------------------------------------------------------------------

  private dropRecoveredMarkers(admissionId: string): void {
    for (const [id, wait] of this.waits)
      if (wait.admissionId === admissionId) this.waits.delete(id);
  }

  private liveWaits(): Wait[] {
    return [...this.waits.values()]
      .filter((w) => w.admissionId === null)
      .sort((a, b) => a.seq - b.seq);
  }

  /** Wake hints in registration order. A hint is not a grant: the runtime re-admits normally. */
  private wake(match: (wait: Wait) => boolean): void {
    for (const wait of this.liveWaits()) {
      if (!match(wait)) continue;
      const runtime = this.runtimes.get(wait.runtimeInstanceId);
      if (!runtime) continue;
      wait.hinted = true;
      try {
        runtime.adapter.send({
          type: "account.routing.resume",
          hostEpoch: this.hostEpoch,
          runtimeInstanceId: wait.runtimeInstanceId,
          waitId: wait.waitId,
        });
      } catch {
        // A dead transport cannot be woken; detach removes its waits.
      }
    }
    this.rearmTimer();
  }

  /** One timer for the earliest unhinted confirmed reset; no polling. */
  private rearmTimer(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
    if (this.disposed) return;
    const due = this.liveWaits()
      .filter((w) => !w.requiresUserAction && !w.hinted && w.nextCheckAt !== null)
      .map((w) => w.nextCheckAt!);
    if (due.length === 0) return;
    const at = Math.min(...due);
    this.cancelTimer = this.clock.setTimer(
      () => {
        this.cancelTimer = null;
        const now = this.clock.now();
        this.wake(
          (w) =>
            !w.requiresUserAction && !w.hinted && w.nextCheckAt !== null && w.nextCheckAt <= now,
        );
        this.rearmTimer();
        this.publish();
      },
      Math.max(0, at - this.clock.now()),
    );
  }
}
