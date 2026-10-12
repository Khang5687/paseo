import { describe, expect, it } from "vitest";
import type {
  OmpAccountRoutingState,
  OmpRoutingAccount,
  OmpRoutingWindow,
} from "@getpaseo/protocol/messages";
import {
  accountRefusal,
  buildNotices,
  buildAccountRows,
  buildWindowViews,
  consumedPercent,
  describeAccount,
  describeSection,
  refKey,
} from "./presentation";

const ref = (row: number, storeNamespace = "ns") => ({ storeNamespace, nativeRowId: row });
const NOW = 1_800_000_000_000;

function account(row: number, patch: Partial<OmpRoutingAccount> = {}): OmpRoutingAccount {
  return {
    ref: ref(row),
    label: `user${row}@example.test`,
    organizationLabel: `Org ${row}`,
    identityLabel: `user${row}@example.test #${row}`,
    organizationIdentityLabel: `Org ${row} #${row}`,
    available: true,
    missing: false,
    authoritativeObservedAt: NOW,
    quotaIdentity: null,
    subscriptionTier: { kind: "unknown", observedAt: null, source: null },
    absoluteAllowance: null,
    windows: [],
    billing: {
      state: "disabled",
      observedAt: NOW,
      validUntil: NOW + 1,
      source: null,
      sourceRevision: null,
      reason: null,
    },
    rank: {} as OmpRoutingAccount["rank"],
    quotaBlocks: [],
    rankingCoverage: "complete",
    ...patch,
  };
}

function state(patch: Partial<OmpAccountRoutingState> = {}): OmpAccountRoutingState {
  return {
    hostEpoch: "e",
    stateSequence: 1,
    policy: {
      policyRevision: 1,
      selectionGeneration: 1,
      current: null,
      autoEnabled: true,
      priorityOrder: [],
      inclusion: [],
    },
    capability: { status: "supported", reason: null },
    catalog: { status: "loaded", authoritativeObservedAt: NOW },
    accounts: [],
    activeRequests: [],
    lastServed: [],
    pausedRequests: [],
    ...patch,
  };
}

function window(patch: Partial<OmpRoutingWindow>): OmpRoutingWindow {
  return {
    id: "5h",
    label: "5h",
    scope: { kind: "shared" },
    usedFraction: 0.5,
    resetAt: null,
    observedAt: NOW,
    validUntil: NOW + 60_000,
    source: "usage-full",
    ...patch,
  };
}

describe("account rows", () => {
  it("orders by policy priority, appends unranked accounts, and keeps a missing current as a tombstone", () => {
    const rows = buildAccountRows(
      state({
        accounts: [account(1), account(2), account(3)],
        policy: { ...state().policy, priorityOrder: [ref(3), ref(1)], current: ref(9) },
      }),
    );
    expect(rows.map((row) => row.ref.nativeRowId)).toEqual([3, 1, 2, 9]);
    expect(rows.map((row) => row.position)).toEqual([1, 2, 3, 4]);
    expect(rows[3]).toMatchObject({ account: null, isCurrent: true });
  });

  it("treats a missing inclusion entry as included and separates serving from merely admitted", () => {
    const request = (phase: "admitted" | "serving", admissionId: string) => ({
      admissionId,
      agentId: "agent",
      nativeSessionId: "s",
      model: "m",
      accountRef: ref(1),
      selectionGeneration: 1,
      phase,
      observedAt: NOW,
    });
    const [first, second] = buildAccountRows(
      state({
        accounts: [account(1), account(2)],
        policy: { ...state().policy, inclusion: [{ account: ref(2), included: false }] },
        activeRequests: [request("admitted", "a"), request("serving", "b")],
      }),
    );
    expect(first).toMatchObject({ included: true });
    expect(first.serving.map((r) => r.admissionId)).toEqual(["b"]);
    expect(first.admitted.map((r) => r.admissionId)).toEqual(["a"]);
    expect(second.included).toBe(false);
  });

  it("keys the same row id in different namespaces apart", () => {
    expect(refKey(ref(1, "a"))).not.toBe(refKey(ref(1, "b")));
  });
});

describe("account names", () => {
  const fallbacks = {
    missing: (id: number) => `Account ${id}`,
    unknownOrganization: "unknown org",
  };

  it("uses identity labels only when labels collide", () => {
    const rows = buildAccountRows(
      state({
        accounts: [
          account(1, {
            label: "same",
            organizationLabel: "Acme",
            organizationIdentityLabel: "Acme #1",
            identityLabel: "same #1",
          }),
          account(2, {
            label: "same",
            organizationLabel: "Acme",
            organizationIdentityLabel: "Acme #2",
            identityLabel: "same #2",
          }),
          account(3, { label: "other", organizationLabel: null }),
        ],
      }),
    );
    expect(describeAccount(rows[0], rows, fallbacks)).toEqual({
      title: "same #1",
      organization: "Acme #1",
    });
    expect(describeAccount(rows[1], rows, fallbacks)).toEqual({
      title: "same #2",
      organization: "Acme #2",
    });
    expect(describeAccount(rows[2], rows, fallbacks)).toEqual({
      title: "other",
      organization: "unknown org",
    });
  });

  it("names a tombstone without a native label", () => {
    const rows = buildAccountRows(state({ policy: { ...state().policy, current: ref(7) } }));
    expect(describeAccount(rows[0], rows, fallbacks).title).toBe("Account 7");
  });
});

describe("windows", () => {
  it("never shows 100% consumed as 100% remaining", () => {
    expect(consumedPercent(0)).toBe(0);
    expect(consumedPercent(0.001)).toBe(1);
    expect(consumedPercent(0.999)).toBe(100);
    expect(consumedPercent(1)).toBe(100);
    const [exhausted, untouched] = buildWindowViews(
      account(1, { windows: [window({ usedFraction: 1 }), window({ id: "7d", usedFraction: 0 })] }),
      NOW,
    );
    expect([exhausted.consumedPct, exhausted.remainingPct]).toEqual([100, 0]);
    expect([untouched.consumedPct, untouched.remainingPct]).toEqual([0, 100]);
  });

  it("orders five-hour, shared weekly, then model windows regardless of server order", () => {
    const views = buildWindowViews(
      account(1, {
        windows: [
          window({ id: "7d", scope: { kind: "model", modelId: "opus" }, label: "opus" }),
          window({ id: "7d", scope: { kind: "shared" } }),
          window({ id: "5h" }),
        ],
      }),
      NOW,
    );
    expect(views.map((view) => view.kind)).toEqual(["fiveHour", "weekly", "model"]);
  });

  it("shows expired, empty and unknown-source readings as unknown and stale, not as a value", () => {
    const [expired, empty, unknownSource] = buildWindowViews(
      account(1, {
        windows: [
          window({ validUntil: NOW - 1 }),
          window({ id: "7d", usedFraction: null }),
          window({ id: "x", source: "unknown" }),
        ],
      }),
      NOW,
    );
    expect(expired).toMatchObject({ consumedPct: null, remainingPct: null, stale: true });
    expect(empty).toMatchObject({ consumedPct: null, stale: false });
    expect(unknownSource).toMatchObject({ consumedPct: null, stale: true });
  });
});

describe("refusals", () => {
  const row = (patch: Partial<OmpRoutingAccount>) =>
    buildAccountRows(state({ accounts: [account(1, patch)] }))[0];

  it("lets billing state outrank a quota block", () => {
    const block = {
      limitId: "l",
      scope: { kind: "shared" as const },
      resetAt: null,
      observedAt: NOW,
      source: "native-usage" as const,
      confirmed: true as const,
    };
    const enabled = {
      state: "enabled" as const,
      observedAt: NOW,
      validUntil: null,
      source: null,
      sourceRevision: null,
      reason: null,
    };
    expect(accountRefusal(row({ quotaBlocks: [block], billing: enabled }), NOW)?.code).toBe(
      "billing_enabled",
    );
    expect(accountRefusal(row({ quotaBlocks: [block] }), NOW)?.code).toBe("quota_blocked");
    expect(accountRefusal(row({ quotaBlocks: [{ ...block, resetAt: NOW - 1 }] }), NOW)).toBeNull();
    expect(accountRefusal(row({ available: false }), NOW)?.kind).toBe("unavailable");
  });
});

describe("section state", () => {
  it("shows recovery only after the pause cleared and treats incomplete catalogs as not empty", () => {
    const paused = {
      waitId: "w",
      agentId: "a",
      nativeSessionId: "n",
      model: "m",
      reason: "all_unavailable" as const,
      nextCheckAt: null,
      requiresUserAction: false,
      accountRef: null,
      recoveredAt: null,
    };
    expect(describeSection(state({ pausedRequests: [paused] }))).toMatchObject({
      paused: { reason: "all_unavailable" },
      recovered: false,
    });
    expect(
      describeSection(state({ pausedRequests: [{ ...paused, recoveredAt: NOW }] }), new Set(["w"])),
    ).toMatchObject({ paused: null, recovered: true });
    expect(
      describeSection(state({ catalog: { status: "incomplete", authoritativeObservedAt: null } }))
        .catalog,
    ).toBe("incomplete");
    expect(
      describeSection(state({ catalog: { status: "loading", authoritativeObservedAt: null } }))
        .phase,
    ).toBe("loading");
  });
});

describe("notices", () => {
  const base = {
    state: state(),
    recoveries: new Set<string>(),
    featureOn: true,
    offline: false,
    readOnly: false,
    pending: false,
    conflict: false,
    error: null,
  };

  it("states support first, then connection and permission, then host conditions", () => {
    const paused = {
      waitId: "w",
      agentId: "a",
      nativeSessionId: "n",
      model: "m",
      reason: "all_unavailable" as const,
      nextCheckAt: null,
      requiresUserAction: false,
      accountRef: null,
      recoveredAt: null,
    };
    const ids = buildNotices({
      ...base,
      state: state({
        capability: { status: "unsupported", reason: "unsupported_runtime" },
        pausedRequests: [paused],
      }),
      offline: true,
      readOnly: true,
      conflict: true,
    }).map((n) => n.id);
    expect(ids).toEqual([
      "unsupported",
      "capabilityReason",
      "offline",
      "readOnly",
      "conflict",
      "paused",
      "pausedReason",
    ]);
  });

  it("is quiet for a healthy host and flags only conflicts and failures as alerts", () => {
    expect(buildNotices(base)).toEqual([]);
    expect(
      buildNotices({ ...base, conflict: true, error: "persistence_failed" })
        .filter((n) => n.alert)
        .map((n) => n.id),
    ).toEqual(["conflict", "error"]);
  });

  it("reads a host that never advertised support as unsupported even without a snapshot", () => {
    expect(buildNotices({ ...base, state: null, featureOn: false }).map((n) => n.id)).toEqual([
      "unsupported",
    ]);
  });
});
