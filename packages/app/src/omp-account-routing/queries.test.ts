import { describe, expect, it, vi } from "vitest";
import type {
  OmpAccountLoginPayload,
  OmpAccountRoutingMutationResult,
  OmpAccountRoutingState,
} from "@getpaseo/protocol/messages";
import {
  AccountLoginController,
  RoutingController,
  type LoginClient,
  type RoutingClient,
} from "./queries";

const ref = (row: number) => ({ storeNamespace: "ns", nativeRowId: row });

function makeState(
  patch: { revision?: number; sequence?: number; epoch?: string; current?: number } = {},
): OmpAccountRoutingState {
  return {
    hostEpoch: patch.epoch ?? "e1",
    stateSequence: patch.sequence ?? 1,
    policy: {
      policyRevision: patch.revision ?? 1,
      selectionGeneration: 1,
      current: ref(patch.current ?? 1),
      autoEnabled: true,
      priorityOrder: [ref(1), ref(2)],
      inclusion: [],
    },
    capability: { status: "supported", reason: null },
    catalog: { status: "loaded", authoritativeObservedAt: 1 },
    accounts: [],
    activeRequests: [],
    lastServed: [],
    pausedRequests: [],
  };
}

/** A host as the client sees it: one snapshot read, a push channel, and revision-checked mutations. */
function fakeHost(initial = makeState()) {
  const observers = new Set<{
    snapshot: (s: OmpAccountRoutingState) => void;
    update: (m: {
      type: "account.routing.state.update";
      payload: { state: OmpAccountRoutingState };
    }) => void;
    error: (e: unknown) => void;
  }>();
  const release = vi.fn(async () => undefined);
  const mutate = vi.fn<RoutingClient["mutateOmpAccountRouting"]>();
  const read = vi.fn(async () => ({
    state: initial,
    subscription: {
      subscriptionId: "s",
      ready: Promise.resolve(initial),
      subscribe: (observer: never) => {
        observers.add(observer);
        return () => observers.delete(observer);
      },
      release,
    },
  }));
  const client = {
    getOmpAccountRoutingState: read,
    mutateOmpAccountRouting: mutate,
  } as unknown as RoutingClient;
  const push = (state: OmpAccountRoutingState) =>
    observers.forEach((o) =>
      o.update({ type: "account.routing.state.update", payload: { state } }),
    );
  const drop = () => observers.forEach((o) => o.error(new Error("closed")));
  return { client, push, drop, mutate, read, release };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function attached(host = fakeHost()) {
  const controller = new RoutingController();
  controller.attach(host.client);
  await flush();
  return { controller, host };
}

describe("RoutingController", () => {
  it("is empty until the host's first snapshot, then follows committed pushes", async () => {
    const host = fakeHost();
    const controller = new RoutingController();
    expect(controller.getSnapshot().state).toBeNull();
    controller.attach(host.client);
    await flush();
    expect(controller.getSnapshot().state?.policy.policyRevision).toBe(1);
    host.push(makeState({ revision: 2, sequence: 2, current: 2 }));
    expect(controller.getSnapshot().state?.policy.current).toEqual(ref(2));
  });

  it("ignores an older push inside one epoch but takes any push from a new epoch", async () => {
    const { controller, host } = await attached(fakeHost(makeState({ sequence: 5 })));
    host.push(makeState({ sequence: 4, revision: 9 }));
    expect(controller.getSnapshot().state?.policy.policyRevision).toBe(1);
    host.push(makeState({ epoch: "e2", sequence: 1, revision: 3 }));
    expect(controller.getSnapshot().state?.policy.policyRevision).toBe(3);
  });

  it("submits the latest revision and shows the host's committed answer, never the attempt", async () => {
    const { controller, host } = await attached();
    let resolve!: (r: OmpAccountRoutingMutationResult) => void;
    host.mutate.mockReturnValue(new Promise((r) => (resolve = r)));
    const pending = controller.mutate({ kind: "select", account: ref(2) });
    expect(controller.getSnapshot()).toMatchObject({ pending: true });
    expect(controller.getSnapshot().state?.policy.current).toEqual(ref(1));
    expect(host.mutate).toHaveBeenCalledWith({
      expectedPolicyRevision: 1,
      command: { kind: "select", account: ref(2) },
    });
    // A second request while one is pending is dropped, not queued.
    await controller.mutate({ kind: "set_auto", enabled: false });
    expect(host.mutate).toHaveBeenCalledTimes(1);
    resolve({
      requestId: "r",
      state: makeState({ revision: 2, sequence: 2, current: 2 }),
      error: null,
    });
    await pending;
    expect(controller.getSnapshot()).toMatchObject({
      pending: false,
      conflict: false,
      error: null,
    });
    expect(controller.getSnapshot().state?.policy.current).toEqual(ref(2));
  });

  it("replaces local state on a stale revision and shows the conflict until the next success", async () => {
    const { controller, host } = await attached();
    host.mutate.mockResolvedValueOnce({
      requestId: "r",
      state: makeState({ revision: 4, sequence: 4, current: 2 }),
      error: { code: "conflict", message: "stale" },
    });
    await controller.mutate({ kind: "set_auto", enabled: false });
    expect(controller.getSnapshot()).toMatchObject({ conflict: true, pending: false });
    expect(controller.getSnapshot().state?.policy).toMatchObject({
      policyRevision: 4,
      autoEnabled: true,
    });
    host.mutate.mockResolvedValueOnce({
      requestId: "r2",
      state: makeState({ revision: 5, sequence: 5 }),
      error: null,
    });
    await controller.mutate({ kind: "set_auto", enabled: false });
    expect(controller.getSnapshot().conflict).toBe(false);
  });

  it("reports a typed host failure without committing", async () => {
    const { controller, host } = await attached();
    host.mutate.mockResolvedValue({
      requestId: "r",
      state: makeState(),
      error: { code: "persistence_failed", message: "x" },
    });
    await controller.mutate({ kind: "set_auto", enabled: false });
    expect(controller.getSnapshot()).toMatchObject({
      error: "persistence_failed",
      conflict: false,
    });
    expect(controller.getSnapshot().state?.policy.autoEnabled).toBe(true);
  });

  it("keeps the last confirmed state offline after a drop and replaces it on reattach", async () => {
    const { controller, host } = await attached();
    host.drop();
    expect(controller.getSnapshot()).toMatchObject({ offline: true });
    expect(controller.getSnapshot().state?.policy.policyRevision).toBe(1);
    // Offline controls do not send.
    await controller.mutate({ kind: "set_auto", enabled: false });
    expect(host.mutate).not.toHaveBeenCalled();
    const next = fakeHost(makeState({ revision: 7, sequence: 9 }));
    controller.attach(next.client);
    await flush();
    expect(controller.getSnapshot()).toMatchObject({ offline: false });
    expect(controller.getSnapshot().state?.policy.policyRevision).toBe(7);
  });

  it("claims neither success nor failure when the transport fails mid-mutation, then refetches", async () => {
    const { controller, host } = await attached();
    host.mutate.mockRejectedValue(new Error("socket closed"));
    await controller.mutate({ kind: "select", account: ref(2) });
    await flush();
    expect(host.mutate).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot()).toMatchObject({
      pending: false,
      conflict: false,
      error: null,
    });
    expect(controller.getSnapshot().state?.policy.current).toEqual(ref(1));
    expect(host.read).toHaveBeenCalledTimes(2);
  });

  it("drops results that arrive after detach and releases the subscription", async () => {
    const { controller, host } = await attached();
    let resolve!: (r: OmpAccountRoutingMutationResult) => void;
    host.mutate.mockReturnValue(new Promise((r) => (resolve = r)));
    const pending = controller.mutate({ kind: "select", account: ref(2) });
    controller.detach();
    expect(host.release).toHaveBeenCalledTimes(1);
    resolve({
      requestId: "r",
      state: makeState({ revision: 2, sequence: 2, current: 2 }),
      error: null,
    });
    await pending;
    expect(controller.getSnapshot().state?.policy.current).toEqual(ref(1));
  });

  it("shows a recovery in the first state that carries it, then drops it", async () => {
    const { controller, host } = await attached();
    const recovered = {
      waitId: "w1",
      agentId: "a",
      nativeSessionId: "n",
      model: "m",
      reason: "all_unavailable" as const,
      nextCheckAt: null,
      requiresUserAction: false,
      accountRef: null,
      recoveredAt: 5,
    };
    host.push({ ...makeState({ sequence: 2 }), pausedRequests: [recovered] });
    expect([...controller.getSnapshot().recoveries]).toEqual(["w1"]);
    host.push({ ...makeState({ sequence: 3 }), pausedRequests: [recovered] });
    expect([...controller.getSnapshot().recoveries]).toEqual([]);
  });

  it("keeps hosts apart: one controller never sees another's pushes", async () => {
    const a = await attached(fakeHost(makeState({ current: 1 })));
    const b = await attached(fakeHost(makeState({ current: 2 })));
    a.host.push(makeState({ sequence: 2, revision: 2, current: 2 }));
    expect(a.controller.getSnapshot().state?.policy.current).toEqual(ref(2));
    expect(b.controller.getSnapshot().state?.policy.policyRevision).toBe(1);
  });
});

describe("AccountLoginController", () => {
  const payload = (
    status: OmpAccountLoginPayload["status"],
    error: OmpAccountLoginPayload["error"] = null,
  ): OmpAccountLoginPayload => ({ requestId: "r", status, error });

  function loginClient(overrides: Partial<LoginClient> = {}): LoginClient {
    return {
      startOmpAccountLogin: vi.fn(async () => payload({ state: "running", startedAt: 1 })),
      getOmpAccountLoginStatus: vi.fn(async () => payload({ state: "idle" })),
      cancelOmpAccountLogin: vi.fn(async () => payload({ state: "cancelled" })),
      submitOmpAccountLoginCode: vi.fn(async () => ({
        requestId: "r",
        status: { state: "running" as const, phase: "verifying" as const },
        error: null,
      })),
      ...overrides,
    };
  }

  it("runs, polls the host until it succeeds, then stops polling", async () => {
    vi.useFakeTimers();
    const statuses: OmpAccountLoginPayload[] = [
      payload({ state: "idle" }), // read once on attach
      payload({ state: "running" }),
      payload({ state: "succeeded" }),
    ];
    const client = loginClient({
      getOmpAccountLoginStatus: vi.fn(async () => statuses.shift() ?? payload({ state: "idle" })),
    });
    const controller = new AccountLoginController();
    controller.attach(client);
    await vi.advanceTimersByTimeAsync(0);

    await controller.start();
    expect(controller.getSnapshot().phase).toBe("running");
    await vi.advanceTimersByTimeAsync(2_100);
    expect(controller.getSnapshot().phase).toBe("running");
    await vi.advanceTimersByTimeAsync(2_100);
    expect(controller.getSnapshot().phase).toBe("succeeded");
    const polls = vi.mocked(client.getOmpAccountLoginStatus).mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vi.mocked(client.getOmpAccountLoginStatus).mock.calls.length).toBe(polls);
    expect(polls).toBe(3);
    controller.detach();
    vi.useRealTimers();
  });

  it("reports the host's failure reason", async () => {
    vi.useFakeTimers();
    const client = loginClient({
      getOmpAccountLoginStatus: vi
        .fn()
        .mockResolvedValueOnce(payload({ state: "idle" }))
        .mockResolvedValue(payload({ state: "failed", failure: "paste_code_unsupported" })),
    });
    const controller = new AccountLoginController();
    controller.attach(client);
    await controller.start();
    await vi.advanceTimersByTimeAsync(2_100);
    expect(controller.getSnapshot()).toMatchObject({
      phase: "failed",
      failure: "paste_code_unsupported",
    });
    controller.detach();
    vi.useRealTimers();
  });

  it("adopts a login another client already started when the host refuses a second one", async () => {
    vi.useFakeTimers();
    const client = loginClient({
      startOmpAccountLogin: vi.fn(async () =>
        payload({ state: "running", startedAt: 5 }, "already_running"),
      ),
    });
    const controller = new AccountLoginController();
    controller.attach(client);
    await controller.start();
    expect(controller.getSnapshot().phase).toBe("running");
    controller.detach();
    vi.useRealTimers();
  });

  it("shows a login that is already running when the page opens", async () => {
    vi.useFakeTimers();
    const client = loginClient({
      getOmpAccountLoginStatus: vi.fn(async () => payload({ state: "running" })),
    });
    const controller = new AccountLoginController();
    controller.attach(client);
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.getSnapshot().phase).toBe("running");
    controller.detach();
    vi.useRealTimers();
  });

  it("does not show an old finished login when the page opens", async () => {
    const now = 10 * 60 * 1000;
    for (const endedAt of [undefined, now - 5 * 60 * 1000 - 1]) {
      const client = loginClient({
        getOmpAccountLoginStatus: vi.fn(async () => payload({ state: "succeeded", endedAt })),
      });
      const controller = new AccountLoginController(() => now);
      controller.attach(client);
      await Promise.resolve();
      expect(controller.getSnapshot().phase).toBe("idle");
      controller.detach();
    }
  });

  it("shows the outcome of a login that ended under five minutes ago when the page opens", async () => {
    const now = 10 * 60 * 1000;
    const addedRef = { storeNamespace: "s", nativeRowId: 3 };
    const client = loginClient({
      getOmpAccountLoginStatus: vi.fn(async () =>
        payload({
          state: "succeeded",
          endedAt: now - 60_000,
          outcome: { kind: "added", label: "bob@example.com", ref: addedRef },
        }),
      ),
    });
    const controller = new AccountLoginController(() => now);
    controller.attach(client);
    await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe("succeeded"));
    expect(controller.getSnapshot()).toMatchObject({
      outcome: { kind: "added", label: "bob@example.com" },
      justAdded: addedRef,
    });
    controller.dismiss();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "idle",
      outcome: null,
      justAdded: addedRef,
    });
    controller.detach();
    expect(controller.getSnapshot().justAdded).toBeNull();
  });

  it("adopts the running step, link and paste prompt, and drops them when the login ends", async () => {
    vi.useFakeTimers();
    const statuses = [
      payload({ state: "idle" }),
      payload({
        state: "running",
        phase: "awaiting_browser",
        authorizeUrl: "https://claude.ai/oauth/authorize?x=1",
        pasteAccepted: true,
      }),
      payload({ state: "failed", failure: "timeout", endedAt: 5 }),
    ];
    const client = loginClient({
      getOmpAccountLoginStatus: vi.fn(async () => statuses.shift() ?? payload({ state: "idle" })),
    });
    const controller = new AccountLoginController();
    controller.attach(client);
    await controller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_100);
    expect(controller.getSnapshot()).toMatchObject({
      phase: "running",
      step: "awaiting_browser",
      authorizeUrl: "https://claude.ai/oauth/authorize?x=1",
      pasteAccepted: true,
    });
    await vi.advanceTimersByTimeAsync(2_100);
    expect(controller.getSnapshot()).toMatchObject({
      phase: "failed",
      failure: "timeout",
      authorizeUrl: null,
      pasteAccepted: false,
    });
    controller.detach();
    vi.useRealTimers();
  });

  it("starts add-only and never opens the link itself", async () => {
    const client = loginClient();
    const controller = new AccountLoginController();
    controller.attach(client);
    await controller.start();
    expect(client.startOmpAccountLogin).toHaveBeenCalledWith({ mode: "add" });
    controller.detach();
  });

  it("submits a pasted address only while the host's prompt is open and keeps a refusal", async () => {
    vi.useFakeTimers();
    const waiting = payload({
      state: "running",
      phase: "awaiting_browser",
      authorizeUrl: "https://claude.ai/a",
      pasteAccepted: true,
    });
    const client = loginClient({
      startOmpAccountLogin: vi.fn(async () => waiting),
      getOmpAccountLoginStatus: vi.fn(async () => waiting),
      submitOmpAccountLoginCode: vi.fn(async () => ({
        requestId: "r",
        status: {
          state: "running" as const,
          phase: "awaiting_browser" as const,
          authorizeUrl: "https://claude.ai/a",
          pasteAccepted: true,
        },
        error: "wrong_login" as const,
      })),
    });
    const controller = new AccountLoginController();
    controller.attach(client);
    await controller.submitCode("ignored: no login yet");
    expect(client.submitOmpAccountLoginCode).not.toHaveBeenCalled();
    await controller.start();
    await controller.submitCode("http://localhost:54545/callback?code=c&state=s");
    expect(client.submitOmpAccountLoginCode).toHaveBeenCalledWith(
      "http://localhost:54545/callback?code=c&state=s",
    );
    expect(controller.getSnapshot()).toMatchObject({
      phase: "running",
      pasteError: "wrong_login",
      submitting: false,
    });
    // A poll between submits does not erase the message.
    await vi.advanceTimersByTimeAsync(2_100);
    expect(controller.getSnapshot().pasteError).toBe("wrong_login");
    controller.detach();
    vi.useRealTimers();
  });

  it("a lost connection while submitting is an unreachable paste error", async () => {
    const client = loginClient({
      startOmpAccountLogin: vi.fn(async () =>
        payload({ state: "running", phase: "awaiting_browser", pasteAccepted: true }),
      ),
      submitOmpAccountLoginCode: vi.fn(async () => {
        throw new Error("offline");
      }),
    });
    const controller = new AccountLoginController();
    controller.attach(client);
    await controller.start();
    await controller.submitCode("x");
    expect(controller.getSnapshot()).toMatchObject({
      phase: "running",
      pasteError: "unreachable",
      submitting: false,
    });
    controller.detach();
  });

  it("cancel asks the host and shows cancelled", async () => {
    vi.useFakeTimers();
    const client = loginClient();
    const controller = new AccountLoginController();
    controller.attach(client);
    await controller.start();
    await controller.cancel();
    expect(client.cancelOmpAccountLogin).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().phase).toBe("cancelled");
    controller.detach();
    vi.useRealTimers();
  });

  it("a transport failure on start is a failure, not a hang", async () => {
    const client = loginClient({
      startOmpAccountLogin: vi.fn(async () => {
        throw new Error("offline");
      }),
    });
    const controller = new AccountLoginController();
    controller.attach(client);
    await controller.start();
    expect(controller.getSnapshot()).toMatchObject({ phase: "failed", failure: "unreachable" });
    controller.detach();
  });
});
