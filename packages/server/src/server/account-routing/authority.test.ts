import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountRoutingAuthority } from "./authority.js";
import { AccountRoutingStore } from "./store.js";
import type {
  AccountRoutingClock,
  AdmissionDecision,
  AdmissionRequest,
  OmpRoutingAccountRef,
  RankCandidatesInput,
  RankCandidatesResult,
  RoutingCatalog,
  RoutingCatalogAccount,
  RoutingMetadataAdapter,
  RoutingWakeFrame,
} from "./types.js";

const NS = "11111111-1111-4111-8111-111111111111";
const RUNTIME = "rt-1";
const MODEL = "claude-sonnet";
const T0 = 1_000_000;
const ref = (nativeRowId: number, storeNamespace = NS): OmpRoutingAccountRef => ({
  storeNamespace,
  nativeRowId,
});

class FakeClock implements AccountRoutingClock {
  time = T0;
  timers: Array<{ at: number; callback: () => void; live: boolean }> = [];
  now() {
    return this.time;
  }
  setTimer(callback: () => void, delayMs: number) {
    const timer = { at: this.time + delayMs, callback, live: true };
    this.timers.push(timer);
    return () => {
      timer.live = false;
    };
  }
  advance(ms: number) {
    this.time += ms;
    for (const timer of this.timers.filter((t) => t.live && t.at <= this.time)) {
      timer.live = false;
      timer.callback();
    }
  }
}

function account(
  row: number,
  patch: Partial<RoutingCatalogAccount> = {},
  ns = NS,
): RoutingCatalogAccount {
  return {
    ref: ref(row, ns),
    display: {
      email: `user${row}@example.test`,
      accountId: `acct-${row}`,
      organizationId: `org-${row}`,
      organizationName: `Org ${row}`,
    },
    credentialAvailable: true,
    quotaIdentity: { accountUuid: `acct-${row}`, organizationUuid: `org-${row}` },
    billing: {
      state: "disabled",
      observedAt: T0,
      validUntil: T0 + 300_000,
      source: "claude-usage-spend",
      sourceRevision: null,
      reason: null,
    },
    subscriptionTier: { kind: "unknown", observedAt: null, source: null },
    windows: [],
    quotaBlocks: [],
    rank: {
      method: "claude-native-window-pressure-v1",
      version: 1,
      modelId: MODEL,
      modelFamily: "sonnet",
      planGateApplies: false,
      planEligibility: true,
      billingEligibility: "eligible",
      applicableLimitIds: [],
      coverage: "complete",
      unknownReasons: [],
      usageMeasured: true,
      primaryHot: false,
      primaryUsed: 0.1,
      secondaryUsed: 0.1,
      primaryRequiredDrain: 0,
      secondaryRequiredDrain: 0,
    },
    ...patch,
  };
}

const blocked = (
  resetAt: number | null,
  scope: RoutingCatalogAccount["quotaBlocks"][number]["scope"] = { kind: "shared" },
) => ({
  limitId: "5h",
  scope,
  resetAt,
  observedAt: T0,
  source: "native-usage" as const,
  confirmed: true as const,
});

let revision = 0;
function catalog(
  accounts: RoutingCatalogAccount[],
  patch: Partial<RoutingCatalog> = {},
): RoutingCatalog {
  revision += 1;
  return {
    provider: "anthropic",
    runtimeInstanceId: RUNTIME,
    storeNamespace: NS,
    catalogRevision: revision,
    nativeCredentialGeneration: 1,
    observedAt: T0,
    authoritativeObservedAt: T0,
    authoritativeComplete: true,
    accounts,
    ...patch,
  };
}

class FakeAdapter implements RoutingMetadataAdapter {
  snapshot: RoutingCatalog[] = [];
  refreshCalls: OmpRoutingAccountRef[] = [];
  rankCalls: RankCandidatesInput[] = [];
  sent: RoutingWakeFrame[] = [];
  refreshImpl: (ref: OmpRoutingAccountRef) => Promise<RoutingCatalog> | RoutingCatalog = () => {
    throw new Error("refresh not configured");
  };
  // Mirrors the native contract: anchor is the lowest primaryUsed, close set within 0.05 of it.
  rankImpl: (input: RankCandidatesInput) => Promise<RankCandidatesResult> | RankCandidatesResult = (
    input,
  ) => ({
    method: "claude-native-window-pressure-v1",
    version: 1,
    catalogRevision: input.catalogRevision,
    anchorRef: input.candidateRefs[0],
    bestCloseRefs: input.candidateRefs,
  });
  catalogSnapshot() {
    return this.snapshot;
  }
  async refreshMetadata(r: OmpRoutingAccountRef) {
    this.refreshCalls.push(r);
    return this.refreshImpl(r);
  }
  async rankCandidates(input: RankCandidatesInput) {
    this.rankCalls.push(input);
    return this.rankImpl(input);
  }
  send(frame: RoutingWakeFrame) {
    this.sent.push(frame);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("AccountRoutingAuthority", () => {
  let dir: string;
  let file: string;
  let clock: FakeClock;
  let adapter: FakeAdapter;
  let authority: AccountRoutingAuthority;
  let ids = 0;
  let attempt = 0;
  const open: AccountRoutingAuthority[] = [];

  function boot(accessible = [NS]) {
    const instance = new AccountRoutingAuthority({
      store: AccountRoutingStore.open(file),
      clock,
      newId: () => `id-${++ids}`,
    });
    open.push(instance);
    adapter = new FakeAdapter();
    instance.attachRuntime(
      {
        runtimeInstanceId: RUNTIME,
        agentId: "agent-1",
        accessibleNamespaces: accessible,
        capabilityVersion: 1,
        completeCoverage: true,
      },
      adapter,
    );
    return instance;
  }
  const req = (patch: Partial<AdmissionRequest> = {}): AdmissionRequest => ({
    runtimeInstanceId: RUNTIME,
    operationId: `op-${++attempt}`,
    attemptId: `at-${attempt}`,
    sessionId: "s1",
    modelId: MODEL,
    purpose: "turn",
    requestGeneration: attempt,
    ...patch,
  });
  const mutate = (command: Parameters<AccountRoutingAuthority["mutate"]>[0]["command"]) =>
    authority.mutate({
      expectedPolicyRevision: authority.snapshot().policy.policyRevision,
      command,
    });

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "routing-authority-"));
    file = path.join(dir, "account-routing.json");
    clock = new FakeClock();
    ids = 0;
    authority = boot();
  });
  afterEach(() => {
    for (const a of open.splice(0)) a.dispose();
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  });

  // A directory where the file belongs makes the atomic rename fail without touching permissions.
  function breakTarget() {
    rmSync(file);
    mkdirSync(file);
  }
  function restoreTarget() {
    rmSync(file, { recursive: true });
    writeFileSync(file, JSON.stringify(authority.snapshot().policy));
  }

  function seed(accounts: RoutingCatalogAccount[]) {
    authority.publishCatalog(RUNTIME, catalog(accounts));
  }

  it("reconciles new identities as one default commit without selecting", () => {
    seed([account(2), account(1)]);
    const { policy } = authority.snapshot();
    expect(policy).toMatchObject({
      policyRevision: 1,
      selectionGeneration: 0,
      current: null,
      autoEnabled: true,
    });
    expect(policy.priorityOrder).toEqual([ref(1), ref(2)]);
    expect(policy.inclusion.every((e) => e.included)).toBe(true);
  });

  it("adds a signed-in row at the end of the order, included, without selecting", async () => {
    seed([account(1)]);
    await mutate({ kind: "select", account: ref(1) });
    const before = authority.snapshot().policy;
    const signedIn = authority.refForSignedInRow(9);
    expect(signedIn).toEqual(ref(9));
    authority.addSignedInAccount(signedIn!);
    const { policy, accounts } = authority.snapshot();
    expect(policy.policyRevision).toBe(before.policyRevision + 1);
    expect(policy.selectionGeneration).toBe(before.selectionGeneration);
    expect(policy.current).toEqual(ref(1));
    expect(policy.priorityOrder).toEqual([ref(1), ref(9)]);
    expect(policy.inclusion).toContainEqual({ account: ref(9), included: true });
    expect(accounts.map((a) => a.ref)).toEqual([ref(1), ref(9)]);
    // Twice is a no-op, and a restart with no runtime still lists the row.
    authority.addSignedInAccount(ref(9));
    expect(authority.snapshot().policy.policyRevision).toBe(policy.policyRevision);
    const restarted = new AccountRoutingAuthority({ store: AccountRoutingStore.open(file), clock });
    open.push(restarted);
    expect(restarted.snapshot().accounts.map((a) => a.ref)).toEqual([ref(1), ref(9)]);
  });

  it("finds the signed-in row's store only when exactly one store is known", () => {
    const empty = new AccountRoutingAuthority({
      store: AccountRoutingStore.open(path.join(dir, "empty.json")),
      clock,
    });
    open.push(empty);
    expect(empty.refForSignedInRow(9)).toBeNull();
    seed([account(1), account(2, {}, "22222222-2222-4222-8222-222222222222")]);
    expect(authority.refForSignedInRow(9)).toBeNull();
  });

  it("rejects a stale revision with the current state and never replays", async () => {
    seed([account(1), account(2)]);
    await mutate({ kind: "set_auto", enabled: false });
    const result = await authority.mutate({
      expectedPolicyRevision: 1,
      command: { kind: "select", account: ref(2) },
    });
    expect(result.error?.code).toBe("conflict");
    expect(result.state.policy).toMatchObject({
      current: null,
      autoEnabled: false,
      policyRevision: 2,
    });
  });

  it("rejects unknown refs but accepts known tombstones", async () => {
    seed([account(1), account(2)]);
    expect((await mutate({ kind: "select", account: ref(99) })).error?.code).toBe(
      "invalid_account",
    );
    authority.publishCatalog(RUNTIME, catalog([account(1)]));
    const state = authority.snapshot();
    expect(state.accounts.find((a) => a.ref.nativeRowId === 2)).toMatchObject({
      missing: true,
      available: false,
    });
    expect(
      (await mutate({ kind: "set_inclusion", account: ref(2), included: false })).error,
    ).toBeNull();
    expect((await mutate({ kind: "select", account: ref(2) })).state.policy.current).toEqual(
      ref(2),
    );
  });

  it("keeps no-op edits free of revisions and bumps generation on same-account reselect", async () => {
    seed([account(1), account(2)]);
    const base = authority.snapshot().policy.policyRevision;
    await mutate({ kind: "set_auto", enabled: true });
    await mutate({ kind: "move_priority", account: ref(1), direction: "up" });
    await mutate({ kind: "move_priority", account: ref(2), direction: "down" });
    await mutate({ kind: "set_inclusion", account: ref(1), included: true });
    expect(authority.snapshot().policy.policyRevision).toBe(base);
    await mutate({ kind: "select", account: ref(1) });
    await mutate({ kind: "select", account: ref(1) });
    expect(authority.snapshot().policy).toMatchObject({
      policyRevision: base + 2,
      selectionGeneration: 2,
    });
  });

  it("moves by identity, swapping with the adjacent present account across tombstones", async () => {
    seed([account(1), account(2), account(3)]);
    authority.publishCatalog(RUNTIME, catalog([account(1), account(3)]));
    await mutate({ kind: "move_priority", account: ref(3), direction: "up" });
    expect(authority.snapshot().policy.priorityOrder).toEqual([ref(3), ref(2), ref(1)]);
  });

  it("manual select of an excluded account preserves auto and inclusion", async () => {
    seed([account(1), account(2)]);
    await mutate({ kind: "set_inclusion", account: ref(2), included: false });
    const { policy } = (await mutate({ kind: "select", account: ref(2) })).state;
    expect(policy.current).toEqual(ref(2));
    expect(policy.autoEnabled).toBe(true);
    expect(policy.inclusion.find((e) => sameRow(e.account, 2))?.included).toBe(false);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "rolls back on write failure",
    async () => {
      seed([account(1), account(2)]);
      const before = authority.snapshot();
      breakTarget();
      const result = await mutate({ kind: "select", account: ref(2) });
      restoreTarget();
      expect(result.error?.code).toBe("persistence_failed");
      expect(result.state.policy).toEqual(before.policy);
      expect(authority.snapshot().stateSequence).toBe(before.stateSequence);
    },
  );

  it("restores tombstoned settings when the same identity returns after a restart", async () => {
    seed([account(1), account(2)]);
    await mutate({ kind: "set_inclusion", account: ref(2), included: false });
    await mutate({ kind: "move_priority", account: ref(2), direction: "up" });
    await mutate({ kind: "select", account: ref(2) });
    authority.dispose();
    authority = boot();
    expect(authority.snapshot().policy).toMatchObject({
      current: ref(2),
      priorityOrder: [ref(2), ref(1)],
    });
    authority.publishCatalog(RUNTIME, catalog([account(1)]));
    expect(authority.snapshot().accounts.map((a) => a.ref.nativeRowId)).toEqual([2, 1]);
    authority.publishCatalog(RUNTIME, catalog([account(1), account(2), account(3)]));
    const { policy } = authority.snapshot();
    expect(policy.inclusion.find((e) => sameRow(e.account, 2))?.included).toBe(false);
    expect(policy.priorityOrder).toEqual([ref(2), ref(1), ref(3)]);
  });

  it("confirms absence only from a complete catalog that is not older", () => {
    seed([account(1), account(2)]);
    const missing = () =>
      authority.snapshot().accounts.find((a) => a.ref.nativeRowId === 2)?.missing;
    authority.publishCatalog(RUNTIME, catalog([account(1)], { authoritativeComplete: false }));
    expect(missing()).toBe(false);
    authority.publishCatalog(RUNTIME, catalog([account(1)], { authoritativeObservedAt: T0 + 1 }));
    expect(missing()).toBe(true);
    authority.publishCatalog(
      RUNTIME,
      catalog([account(1), account(2)], { authoritativeObservedAt: T0 - 1 }),
    );
    expect(missing()).toBe(true);
    expect(authority.snapshot().policy.priorityOrder).toEqual([ref(1), ref(2)]);
  });

  it("serves observers in sequence order and only when state changes", async () => {
    const seen: number[] = [];
    const sub = await authority.observe((s) => seen.push(s.stateSequence));
    seed([account(1)]);
    seed([account(1)].map((a) => a));
    await mutate({ kind: "set_auto", enabled: true });
    await Promise.resolve();
    expect(seen).toEqual([...new Set(seen)].sort((a, b) => a - b));
    expect(seen[0]).toBe(sub.state.stateSequence + 1);
    sub.release();
  });

  it("follows runtime coverage", () => {
    const fresh = new AccountRoutingAuthority({ store: AccountRoutingStore.open(file), clock });
    open.push(fresh);
    expect(fresh.snapshot().capability.status).toBe("unknown");
    fresh.attachRuntime(
      {
        runtimeInstanceId: "a",
        agentId: "x",
        accessibleNamespaces: [],
        capabilityVersion: 1,
        completeCoverage: null,
      },
      new FakeAdapter(),
    );
    expect(fresh.snapshot().capability.status).toBe("unknown");
    fresh.attachRuntime(
      {
        runtimeInstanceId: "b",
        agentId: "y",
        accessibleNamespaces: [],
        capabilityVersion: 1,
        completeCoverage: false,
      },
      new FakeAdapter(),
    );
    expect(fresh.snapshot().capability).toEqual({
      status: "unsupported",
      reason: "unsupported_runtime",
    });
  });

  it("follows the probed capability only while no runtime is attached", async () => {
    const fresh = new AccountRoutingAuthority({ store: AccountRoutingStore.open(file), clock });
    open.push(fresh);
    const seen: string[] = [];
    await fresh.observe((state) => seen.push(state.capability.status));
    fresh.setProbedCapability({ status: "supported", reason: null });
    expect(fresh.snapshot().capability.status).toBe("supported");
    expect(fresh.snapshot().catalog.status).toBe("loading");
    expect(fresh.snapshot().accounts).toEqual([]);
    fresh.setProbedCapability({ status: "unsupported", reason: "unsupported_runtime" });
    expect(fresh.snapshot().capability.status).toBe("unsupported");
    fresh.setProbedCapability({ status: "supported", reason: null });
    const runtime = fresh.attachRuntime(
      {
        runtimeInstanceId: "a",
        agentId: "x",
        accessibleNamespaces: [],
        capabilityVersion: 1,
        completeCoverage: null,
      },
      new FakeAdapter(),
    );
    // A running agent overrides the probe with today's rules.
    expect(fresh.snapshot().capability.status).toBe("unknown");
    runtime.dispose();
    expect(fresh.snapshot().capability.status).toBe("supported");
    await Promise.resolve();
    expect(seen).toContain("supported");
  });

  it("refuses mutation when unsupported", async () => {
    const fresh = new AccountRoutingAuthority({ store: AccountRoutingStore.open(file), clock });
    open.push(fresh);
    fresh.attachRuntime(
      {
        runtimeInstanceId: "b",
        agentId: "y",
        accessibleNamespaces: [],
        capabilityVersion: 2,
        completeCoverage: true,
      },
      new FakeAdapter(),
    );
    const result = await fresh.mutate({
      expectedPolicyRevision: 0,
      command: { kind: "set_auto", enabled: false },
    });
    expect(result.error?.code).toBe("unsupported");
  });

  it("keeps a usable current without ranking, and keeps a manual choice for the next request only", async () => {
    seed([account(1), account(2)]);
    await mutate({ kind: "select", account: ref(1) });
    const first = await authority.admit(req());
    expect(first).toMatchObject({ kind: "admit", accountRef: ref(1) });
    await mutate({ kind: "select", account: ref(2) });
    const second = await authority.admit(req());
    expect(second).toMatchObject({ kind: "admit", accountRef: ref(2) });
    expect(adapter.rankCalls).toEqual([]);
    const active = authority.snapshot().activeRequests;
    expect(active.map((a) => a.accountRef.nativeRowId)).toEqual([1, 2]);
    expect(active[0].selectionGeneration).toBeLessThan(active[1].selectionGeneration);
  });

  it("distinguishes admitted from serving and keeps one last-served per agent", async () => {
    seed([account(1)]);
    await mutate({ kind: "select", account: ref(1) });
    const d = (await authority.admit(req())) as Extract<AdmissionDecision, { kind: "admit" }>;
    expect(authority.snapshot().activeRequests[0].phase).toBe("admitted");
    authority.started({
      runtimeInstanceId: RUNTIME,
      admissionId: d.admissionId,
      startedAt: T0 + 5,
    });
    expect(authority.snapshot()).toMatchObject({
      activeRequests: [{ phase: "serving" }],
      lastServed: [{ agentId: "agent-1", servedAt: T0 + 5 }],
    });
    authority.outcome({
      runtimeInstanceId: RUNTIME,
      admissionId: d.admissionId,
      hostEpoch: authority.hostEpoch,
      accountRef: ref(1),
      selectionGeneration: d.selectionGeneration,
      quotaBlocks: [],
    });
    authority.outcome({
      runtimeInstanceId: RUNTIME,
      admissionId: d.admissionId,
      hostEpoch: authority.hostEpoch,
      accountRef: ref(1),
      selectionGeneration: d.selectionGeneration,
      quotaBlocks: [],
    });
    expect(authority.snapshot().activeRequests).toEqual([]);
    expect(authority.snapshot().lastServed).toHaveLength(1);
  });

  it("refuses the inaccessible global choice without changing it", async () => {
    authority.dispose();
    authority = boot([]);
    seed([account(1), account(2)]);
    await mutate({ kind: "select", account: ref(1) });
    const rev = authority.snapshot().policy.policyRevision;
    expect(await authority.admit(req())).toEqual({
      kind: "refuse",
      reason: "source_inaccessible",
      requiresUserAction: true,
    });
    expect(authority.snapshot().policy.policyRevision).toBe(rev);
  });

  it("refreshes an enabled current row once and refuses with user action", async () => {
    seed([
      account(1, {
        billing: {
          state: "enabled",
          observedAt: T0,
          validUntil: T0 + 300_000,
          source: "claude-usage-spend",
          sourceRevision: null,
          reason: null,
        },
      }),
      account(2),
    ]);
    await mutate({ kind: "select", account: ref(1) });
    adapter.refreshImpl = () =>
      catalog([
        account(1, {
          billing: {
            state: "enabled",
            observedAt: T0,
            validUntil: T0 + 300_000,
            source: "claude-usage-spend",
            sourceRevision: null,
            reason: null,
          },
        }),
        account(2),
      ]);
    expect(await authority.admit(req())).toEqual({
      kind: "refuse",
      reason: "billing_enabled",
      requiresUserAction: true,
    });
    expect(adapter.refreshCalls).toEqual([ref(1)]);
  });

  it("admits after the one refresh proves billing disabled again", async () => {
    const expired = {
      state: "disabled" as const,
      observedAt: T0 - 400_000,
      validUntil: T0 - 100_000,
      source: "claude-usage-spend" as const,
      sourceRevision: null,
      reason: null,
    };
    seed([account(1, { billing: expired })]);
    await mutate({ kind: "select", account: ref(1) });
    adapter.refreshImpl = () => catalog([account(1)]);
    expect(await authority.admit(req())).toMatchObject({ kind: "admit" });
    expect(adapter.refreshCalls).toHaveLength(1);
  });

  it("reports unknown billing when the refresh fails", async () => {
    seed([
      account(1, {
        billing: {
          state: "unknown",
          observedAt: null,
          validUntil: null,
          source: null,
          sourceRevision: null,
          reason: "expired",
        },
      }),
    ]);
    await mutate({ kind: "select", account: ref(1) });
    expect(await authority.admit(req())).toEqual({
      kind: "refuse",
      reason: "billing_unknown",
      requiresUserAction: true,
    });
  });

  it("never selects an account with unsafe billing as fallback", async () => {
    const enabled = account(2, {
      billing: {
        state: "enabled",
        observedAt: T0,
        validUntil: T0 + 300_000,
        source: "claude-usage-spend",
        sourceRevision: null,
        reason: null,
      },
    });
    seed([account(1, { quotaBlocks: [blocked(null)] }), enabled]);
    await mutate({ kind: "select", account: ref(1) });
    adapter.refreshImpl = () => catalog([account(1, { quotaBlocks: [blocked(null)] }), enabled]);
    const decision = await authority.admit(req());
    expect(decision).toMatchObject({ kind: "refuse", requiresUserAction: true });
    expect(authority.snapshot().policy.current).toEqual(ref(1));
  });

  it("scopes a model block to the requested model", async () => {
    seed([
      account(1, {
        quotaBlocks: [blocked(T0 + 60_000, { kind: "model", modelId: "claude-opus" })],
      }),
      account(2),
    ]);
    await mutate({ kind: "select", account: ref(1) });
    expect(await authority.admit(req())).toMatchObject({ kind: "admit", accountRef: ref(1) });
    expect(await authority.admit(req({ modelId: "claude-opus" }))).toMatchObject({
      kind: "admit",
      accountRef: ref(2),
    });
    expect(authority.snapshot().policy.current).toEqual(ref(2));
  });

  for (const size of [2, 5, 6]) {
    it(`falls back once across a ${size}-account pool, ranking only the included subset`, async () => {
      const rows = Array.from({ length: size }, (_, i) => i + 1);
      seed(rows.map((r) => account(r, r === 1 ? { quotaBlocks: [blocked(null)] } : {})));
      await mutate({ kind: "select", account: ref(1) });
      // Highest-ranked anchor (row 2) is excluded; host must rank the rest, not filter afterwards.
      if (size > 2) await mutate({ kind: "set_inclusion", account: ref(2), included: false });
      if (size > 3) await mutate({ kind: "move_priority", account: ref(size), direction: "up" });
      adapter.rankImpl = (input) => ({
        method: "claude-native-window-pressure-v1",
        version: 1,
        catalogRevision: input.catalogRevision,
        anchorRef: input.candidateRefs[0],
        bestCloseRefs: input.candidateRefs.slice(0, 2),
      });
      const before = authority.snapshot().policy;
      const decision = await authority.admit(req());
      const expectedCandidates = rows.filter((r) => r !== 1 && !(size > 2 && r === 2));
      expect(decision).toMatchObject({ kind: "admit" });
      if (expectedCandidates.length === 1) {
        expect(adapter.rankCalls).toHaveLength(0);
      } else {
        expect(adapter.rankCalls).toHaveLength(1);
        const asked = adapter.rankCalls[0].candidateRefs.map((r) => r.nativeRowId).sort();
        expect(asked).toEqual([...expectedCandidates].sort());
      }
      const after = authority.snapshot().policy;
      expect(after.selectionGeneration).toBe(before.selectionGeneration + 1);
      expect(after.current).toEqual(
        (decision as Extract<AdmissionDecision, { kind: "admit" }>).accountRef,
      );
      if (size > 2) expect(after.current?.nativeRowId).not.toBe(2);
      // Stays on the destination: the next request does not rank or switch.
      await authority.admit(req());
      expect(adapter.rankCalls.length).toBeLessThanOrEqual(1);
      expect(authority.snapshot().policy.current).toEqual(after.current);
    });
  }

  it("picks the earliest user priority inside the anchored close set", async () => {
    seed([account(1, { quotaBlocks: [blocked(null)] }), account(2), account(3), account(4)]);
    await mutate({ kind: "select", account: ref(1) });
    await mutate({ kind: "move_priority", account: ref(4), direction: "up" });
    await mutate({ kind: "move_priority", account: ref(4), direction: "up" });
    adapter.rankImpl = (input) => ({
      method: "claude-native-window-pressure-v1",
      version: 1,
      catalogRevision: input.catalogRevision,
      anchorRef: ref(2),
      bestCloseRefs: [ref(2), ref(4)],
    });
    expect(await authority.admit(req())).toMatchObject({ kind: "admit", accountRef: ref(4) });
  });

  it("lets a manual selection during ranking win over the stale proposal", async () => {
    seed([account(1, { quotaBlocks: [blocked(null)] }), account(2), account(3), account(4)]);
    await mutate({ kind: "select", account: ref(1) });
    const gate = deferred<RankCandidatesResult>();
    adapter.rankImpl = () => gate.promise;
    const pending = authority.admit(req());
    await Promise.resolve();
    await Promise.resolve();
    expect(adapter.rankCalls).toHaveLength(1);
    await mutate({ kind: "select", account: ref(3) });
    gate.resolve({
      method: "claude-native-window-pressure-v1",
      version: 1,
      catalogRevision: adapter.rankCalls[0].catalogRevision,
      anchorRef: ref(2),
      bestCloseRefs: [ref(2)],
    });
    expect(await pending).toMatchObject({ kind: "admit", accountRef: ref(3) });
    expect(authority.snapshot().policy.current).toEqual(ref(3));
    expect(authority.snapshot().policy.selectionGeneration).toBe(2);
  });

  it("refreshes cold rows one at a time in priority order and stops at the first admissible", async () => {
    const cold = (row: number) =>
      account(row, {
        billing: {
          state: "unknown",
          observedAt: null,
          validUntil: null,
          source: null,
          sourceRevision: null,
          reason: "expired",
        },
      });
    seed([account(1, { quotaBlocks: [blocked(null)] }), cold(2), cold(3), cold(4)]);
    await mutate({ kind: "select", account: ref(1) });
    await mutate({ kind: "move_priority", account: ref(4), direction: "up" });
    await mutate({ kind: "move_priority", account: ref(4), direction: "up" });
    adapter.refreshImpl = (r) => {
      const pool = [account(1, { quotaBlocks: [blocked(null)] }), cold(2), cold(3), cold(4)].map(
        (a) => (sameRow(a.ref, r.nativeRowId) && r.nativeRowId !== 4 ? a : a),
      );
      return catalog(
        pool.map((a) =>
          a.ref.nativeRowId === r.nativeRowId && r.nativeRowId === 3 ? account(3) : a,
        ),
      );
    };
    expect(await authority.admit(req())).toMatchObject({ kind: "admit", accountRef: ref(3) });
    expect(adapter.refreshCalls.map((r) => r.nativeRowId)).toEqual([4, 2, 3]);
    expect(adapter.rankCalls).toHaveLength(0);
  });

  it("refuses to rank a subset that spans catalogs", async () => {
    const other = "22222222-2222-4222-8222-222222222222";
    authority.dispose();
    authority = boot([NS, other]);
    authority.publishCatalog(
      RUNTIME,
      catalog([account(1, { quotaBlocks: [blocked(null)] }), account(2)]),
    );
    authority.publishCatalog(RUNTIME, catalog([account(3, {}, other)], { storeNamespace: other }));
    await mutate({ kind: "select", account: ref(1) });
    expect(await authority.admit(req())).toEqual({
      kind: "refuse",
      reason: "unsupported_runtime",
      requiresUserAction: true,
    });
    expect(adapter.rankCalls).toHaveLength(0);
  });

  it("records a late outcome on the old account only and keeps the newer choice", async () => {
    seed([account(1), account(2)]);
    await mutate({ kind: "select", account: ref(1) });
    const d = (await authority.admit(req())) as Extract<AdmissionDecision, { kind: "admit" }>;
    await mutate({ kind: "select", account: ref(2) });
    const policy = authority.snapshot().policy;
    authority.outcome({
      runtimeInstanceId: RUNTIME,
      admissionId: d.admissionId,
      hostEpoch: authority.hostEpoch,
      accountRef: ref(1),
      selectionGeneration: d.selectionGeneration,
      quotaBlocks: [blocked(T0 + 600_000, { kind: "model", modelId: MODEL })],
    });
    const state = authority.snapshot();
    expect(state.policy).toEqual(policy);
    expect(state.accounts.find((a) => a.ref.nativeRowId === 1)?.quotaBlocks).toHaveLength(1);
    expect(state.accounts.find((a) => a.ref.nativeRowId === 2)?.quotaBlocks).toHaveLength(0);
    expect(await authority.admit(req())).toMatchObject({ kind: "admit", accountRef: ref(2) });
  });

  async function blockAll(resetA: number, resetB: number) {
    seed([
      account(1, { quotaBlocks: [blocked(resetA)] }),
      account(2, { quotaBlocks: [blocked(resetB)] }),
    ]);
    await mutate({ kind: "select", account: ref(1) });
  }
  const waitOf = (d: AdmissionDecision) =>
    (d as Extract<AdmissionDecision, { kind: "wait" }>).waitId;

  it("waits for the earliest confirmed reset instead of cycling", async () => {
    await blockAll(T0 + 60_000, T0 + 120_000);
    const d = await authority.admit(req());
    expect(d).toMatchObject({
      kind: "wait",
      reason: "all_unavailable",
      reconsiderAt: T0 + 60_000,
      requiresUserAction: false,
    });
    expect(authority.snapshot().policy.selectionGeneration).toBe(1);
    expect(adapter.rankCalls).toHaveLength(0);
  });

  it("refuses with user action when no reset is known", async () => {
    await blockAll(0, 0);
    seed([
      account(1, { quotaBlocks: [blocked(null)] }),
      account(2, { quotaBlocks: [blocked(null)] }),
    ]);
    expect(await authority.admit(req())).toEqual({
      kind: "refuse",
      reason: "quota_blocked",
      requiresUserAction: true,
    });
  });

  it("sends wake hints in registration order when the reset passes, and re-admits to recover", async () => {
    await blockAll(T0 + 60_000, T0 + 60_000);
    const w1 = waitOf(await authority.admit(req({ sessionId: "s1" })));
    const w2 = waitOf(await authority.admit(req({ sessionId: "s2" })));
    expect(authority.snapshot().pausedRequests.map((p) => p.waitId)).toEqual([w1, w2]);
    clock.advance(59_999);
    expect(adapter.sent).toEqual([]);
    clock.advance(1);
    expect(adapter.sent.map((f) => f.waitId)).toEqual([w1, w2]);
    expect(adapter.sent[0]).toMatchObject({
      type: "account.routing.resume",
      hostEpoch: authority.hostEpoch,
      runtimeInstanceId: RUNTIME,
    });

    // Native reports the reset by delivering fresh metadata, then re-admits with the prior wait id.
    authority.publishCatalog(
      RUNTIME,
      catalog([account(1), account(2)], { observedAt: T0 + 60_001 }),
    );
    const again = await authority.admit(req({ previousWaitId: w1, sessionId: "s1" }));
    expect(again).toMatchObject({ kind: "admit", accountRef: ref(1) });
    const paused = authority.snapshot().pausedRequests;
    expect(paused.find((p) => p.waitId === w1)?.recoveredAt).toBe(T0 + 60_000);
    expect(paused.find((p) => p.waitId === w2)?.recoveredAt).toBeNull();
    // Recovery marker leaves once the recovered request settles.
    authority.outcome({
      runtimeInstanceId: RUNTIME,
      admissionId: (again as { admissionId: string }).admissionId,
      hostEpoch: authority.hostEpoch,
      accountRef: ref(1),
      selectionGeneration: 1,
      quotaBlocks: [],
    });
    expect(authority.snapshot().pausedRequests.map((p) => p.waitId)).toEqual([w2]);
  });

  it("never wakes a cancelled wait and refuses a late re-admission", async () => {
    await blockAll(T0 + 60_000, T0 + 60_000);
    const d1 = req({ sessionId: "s1" });
    const w1 = waitOf(await authority.admit(d1));
    const w2 = waitOf(await authority.admit(req({ sessionId: "s2" })));
    authority.cancel({
      runtimeInstanceId: RUNTIME,
      operationId: d1.operationId,
      attemptId: d1.attemptId,
      waitId: w1,
    });
    authority.cancel({
      runtimeInstanceId: RUNTIME,
      operationId: d1.operationId,
      attemptId: d1.attemptId,
      waitId: w1,
    });
    clock.advance(60_000);
    expect(adapter.sent.map((f) => f.waitId)).toEqual([w2]);
    expect(await authority.admit(req({ previousWaitId: w1 }))).toMatchObject({
      kind: "refuse",
      reason: "cancelled",
    });
    expect(clock.timers.filter((t) => t.live)).toEqual([]);
  });

  it("keeps an auto-off wait paused through resets until manual selection or auto re-enable", async () => {
    await blockAll(T0 + 60_000, T0 + 60_000);
    await mutate({ kind: "set_auto", enabled: false });
    const d = await authority.admit(req());
    expect(d).toMatchObject({ kind: "wait", reason: "auto_disabled", requiresUserAction: true });
    expect(authority.snapshot().pausedRequests[0]).toMatchObject({
      nextCheckAt: null,
      requiresUserAction: true,
    });
    clock.advance(120_000);
    authority.publishCatalog(
      RUNTIME,
      catalog([account(1), account(2)], { observedAt: T0 + 120_000 }),
    );
    expect(adapter.sent).toEqual([]);
    await mutate({ kind: "select", account: ref(2) });
    expect(adapter.sent.map((f) => f.waitId)).toEqual([waitOf(d)]);
  });

  it("wakes only live work and clears the timer when the runtime detaches", async () => {
    await blockAll(T0 + 60_000, T0 + 60_000);
    await authority.admit(req());
    authority.disposeAgent("agent-1");
    expect(authority.snapshot().pausedRequests).toEqual([]);
    clock.advance(60_000);
    expect(adapter.sent).toEqual([]);
  });

  it("does not revive an admission cancelled while its refresh is in flight", async () => {
    const expired = {
      state: "unknown" as const,
      observedAt: null,
      validUntil: null,
      source: null,
      sourceRevision: null,
      reason: "expired" as const,
    };
    seed([account(1, { billing: expired })]);
    await mutate({ kind: "select", account: ref(1) });
    const gate = deferred<RoutingCatalog>();
    adapter.refreshImpl = () => gate.promise;
    const r = req();
    const pending = authority.admit(r);
    await Promise.resolve();
    authority.cancel({
      runtimeInstanceId: RUNTIME,
      operationId: r.operationId,
      attemptId: r.attemptId,
    });
    gate.resolve(catalog([account(1)]));
    expect(await pending).toMatchObject({ kind: "refuse", reason: "cancelled" });
    expect(authority.snapshot().activeRequests).toEqual([]);
  });

  it("falls back to namespace:row identity for duplicate or missing labels", () => {
    const dup = (row: number) =>
      account(row, {
        display: {
          email: "same@example.test",
          accountId: null,
          organizationId: null,
          organizationName: "Team",
        },
      });
    seed([
      dup(1),
      dup(2),
      account(3, {
        display: { email: null, accountId: null, organizationId: null, organizationName: null },
      }),
    ]);
    const accounts = authority.snapshot().accounts;
    expect(accounts[0]).toMatchObject({
      label: "same@example.test",
      identityLabel: `${NS}:1`,
      organizationIdentityLabel: `${NS}:1`,
    });
    expect(accounts[2]).toMatchObject({
      label: "Account 3",
      organizationLabel: null,
      identityLabel: `${NS}:3`,
    });
  });
});

function sameRow(value: OmpRoutingAccountRef, row: number): boolean {
  return value.nativeRowId === row;
}
