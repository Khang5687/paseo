import { afterEach, expect, test, vi } from "vitest";
import type { OmpAccountRoutingState } from "@getpaseo/protocol/messages";
import {
  OmpAccountLoginUnsupportedError,
  OmpAccountRoutingUnsupportedError,
} from "@getpaseo/client";
import { DaemonClient } from "../test-utils/daemon-client.js";
import pino from "pino";
import { OmpAccountLogin } from "./login.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import {
  ROUTING_MODEL,
  routingAccount,
  routingCatalog,
  routingRef,
  FakeOmp,
} from "../agent/providers/omp/test-utils/fake-omp.js";

// Synthetic accounts, a scripted JSONL child, a temp home and port zero. No credential is read and
// no process or network is used; the daemon's own authority admits through the real bridge.
const A = routingRef(1);
const B = routingRef(2);

function freshCatalog(runtimeInstanceId: string) {
  const now = Date.now();
  const fresh = (row: number) => {
    const account = routingAccount(row);
    return {
      ...account,
      billing: { ...account.billing, observedAt: now, validUntil: now + 300_000 },
    };
  };
  return routingCatalog(runtimeInstanceId, [fresh(1), fresh(2)], {
    observedAt: now,
    authoritativeObservedAt: now,
  });
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup().catch(() => undefined);
});

async function startDaemon(options: Parameters<typeof createTestPaseoDaemon>[0] = {}) {
  const daemon = await createTestPaseoDaemon({
    mcpEnabled: false,
    ompRouting: { catalogs: (id) => [freshCatalog(id)] },
    ...options,
  });
  cleanups.push(daemon.close);
  return daemon;
}

async function connect(daemon: TestPaseoDaemon, capabilities?: Record<string, boolean>) {
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.8.0",
    capabilities,
  });
  cleanups.push(() => client.close());
  await client.connect();
  return client;
}

const modern = { owned_subscriptions: true };
const featureOn = (client: DaemonClient) =>
  client.getLastServerInfoMessage()?.features?.ompAccountRouting === true;

test("feature follows negotiated coverage, subscribers see committed changes, conflicts and restarts hold", async () => {
  const daemon = await startDaemon({ cleanup: false });
  const fixture = daemon.routingFixture!;
  const client = await connect(daemon, modern);
  const other = await connect(daemon, modern);
  const legacy = await connect(daemon);
  // Modern clients learn of capability changes through the same event feed the app uses.
  client.observeEvents(["status.server_info"], { notifications: true });
  other.observeEvents(["status.server_info"], { notifications: true });
  const legacyFrames: string[] = [];
  legacy.subscribeRawMessages((message) => legacyFrames.push(message.type));

  // No runtime has negotiated yet: the feature is off and the typed gate refuses before sending.
  expect(featureOn(client)).toBe(false);
  await expect(client.getOmpAccountRoutingState()).rejects.toBeInstanceOf(
    OmpAccountRoutingUnsupportedError,
  );

  const { agentId, runtimeInstanceId } = await fixture.openAgent(daemon.staticDir);

  await expect.poll(() => featureOn(client)).toBe(true);

  const read = await client.getOmpAccountRoutingState({ subscribe: {} });
  const updates: OmpAccountRoutingState[] = [];
  read.subscription!.subscribe({
    snapshot: () => undefined,
    update: (message) => {
      if (message.type === "account.routing.state.update") updates.push(message.payload.state);
    },
  });
  expect(read.state.capability.status).toBe("supported");
  expect(read.state.accounts.map((a) => a.ref)).toEqual([A, B]);

  // Next admission serves the selected account; the select commits and reaches the subscriber.
  const select = await client.mutateOmpAccountRouting({
    expectedPolicyRevision: read.state.policy.policyRevision,
    command: { kind: "select", account: B },
  });
  expect(select.error).toBeNull();
  expect(select.state.policy.current).toEqual(B);
  await expect.poll(() => updates.at(-1)?.policy.current).toEqual(B);

  // A second client with a stale revision loses cleanly and sees the truthful state.
  const stale = await other.mutateOmpAccountRouting({
    expectedPolicyRevision: read.state.policy.policyRevision,
    command: { kind: "set_auto", enabled: false },
  });
  expect(stale.error?.code).toBe("conflict");
  expect(stale.state.policy.current).toEqual(B);
  const unknownAccount = await other.mutateOmpAccountRouting({
    expectedPolicyRevision: select.state.policy.policyRevision,
    command: { kind: "select", account: routingRef(99) },
  });
  expect(unknownAccount.error?.code).toBe("invalid_account");

  const move = await other.mutateOmpAccountRouting({
    expectedPolicyRevision: select.state.policy.policyRevision,
    command: { kind: "move_priority", account: B, direction: "up" },
  });
  expect(move.error).toBeNull();
  await expect.poll(() => updates.at(-1)?.policy.priorityOrder[0]).toEqual(B);

  // Admission through the real JSONL bridge lands on the selected account and is visible live.
  const decision = await fixture.requestAdmission({
    runtimeInstanceId,
    operationId: "op-1",
    sessionId: "native-1",
    modelId: ROUTING_MODEL,
    catalog: freshCatalog(runtimeInstanceId) as never,
  });
  expect(decision).toMatchObject({ kind: "admit", accountRef: B });
  await expect.poll(() => updates.at(-1)?.activeRequests[0]?.agentId).toBe(agentId);

  // A released subscription and a legacy client get no routing events.
  await read.subscription!.release();
  const seen = updates.length;
  const turnedOff = await other.mutateOmpAccountRouting({
    expectedPolicyRevision: move.state.policy.policyRevision,
    command: { kind: "set_auto", enabled: false },
  });
  expect(turnedOff.error).toBeNull();
  expect(updates.length).toBe(seen);
  expect(legacyFrames.filter((type) => type.startsWith("account.routing"))).toEqual([]);

  // Archiving the agent tells the authority exactly once, clears its transient work and, as the last
  // runtime detaches, withdraws the feature.
  const dispose = vi.spyOn(fixture.authority, "disposeAgent");
  await client.archiveAgent(agentId);
  await expect.poll(() => featureOn(client)).toBe(false);
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(dispose).toHaveBeenCalledWith(agentId);
  expect(fixture.authority.snapshot().activeRequests).toEqual([]);
  await expect(client.getOmpAccountRoutingState()).rejects.toBeInstanceOf(
    OmpAccountRoutingUnsupportedError,
  );

  // Durable policy survives an isolated restart; transient work does not.
  const policy = fixture.authority.snapshot().policy;
  await daemon.close();
  const restarted = await startDaemon({
    paseoHomeRoot: daemon.paseoHome.replace(/\/\.paseo$/, ""),
  });
  const again = await connect(restarted, modern);
  again.observeEvents(["status.server_info"], { notifications: true });
  await restarted.routingFixture!.openAgent(restarted.staticDir);
  await expect.poll(() => featureOn(again)).toBe(true);
  const restored = (await again.getOmpAccountRoutingState()).state;
  expect(restored.policy.policyRevision).toBe(policy.policyRevision);
  expect(restored.policy).toMatchObject({
    current: policy.current,
    autoEnabled: false,
    priorityOrder: policy.priorityOrder,
  });
  expect(restored.activeRequests).toEqual([]);
});

test("a runtime without complete coverage never turns the feature on", async () => {
  const daemon = await startDaemon({
    ompRouting: {
      configure: () => ({ completeCoverage: false }),
      catalogs: (id) => [freshCatalog(id)],
    },
  });
  const client = await connect(daemon, modern);
  // Native refuses to manage: the launch fails closed instead of running unmanaged.
  await expect(daemon.routingFixture!.openAgent(daemon.staticDir)).rejects.toThrow(
    "unsupported_runtime",
  );
  expect(daemon.routingFixture!.authority.snapshot().capability.status).not.toBe("supported");
  expect(featureOn(client)).toBe(false);
  await expect(client.getOmpAccountRoutingState()).rejects.toBeInstanceOf(
    OmpAccountRoutingUnsupportedError,
  );
});

test("a probe that reports support advertises routing and login with no agent running", async () => {
  const ompAccountLogin = new OmpAccountLogin({
    runtime: new FakeOmp(),
    logger: pino({ level: "silent" }),
    openUrl: async () => undefined,
  });
  const daemon = await startDaemon({
    cleanup: false,
    ompAccountLogin,
    ompCapabilityProbe: async () => ({ complete: true, version: 1 }),
  });
  const client = await connect(daemon, modern);
  await expect.poll(() => featureOn(client)).toBe(true);
  expect(client.getLastServerInfoMessage()?.features?.ompAccountLogin).toBe(true);
  const { state } = await client.getOmpAccountRoutingState();
  expect(state.capability.status).toBe("supported");
  expect(state.accounts).toEqual([]);
});

test("a probe that reports an old OMP keeps routing off", async () => {
  const daemon = await startDaemon({
    cleanup: false,
    ompCapabilityProbe: async () => ({ complete: false, version: 0 }),
  });
  const client = await connect(daemon, modern);
  expect(featureOn(client)).toBe(false);
  expect(daemon.routingFixture!.authority.snapshot().capability.status).toBe("unsupported");
});

test("account login is advertised only with routing and a host login, and runs end to end", async () => {
  const omp = new FakeOmp();
  const opened: string[] = [];
  omp.queueSessionSetup((session) => {
    session.loginHandler = async (s) =>
      s.emit({
        type: "extension_ui_request",
        id: "u1",
        method: "open_url",
        url: "https://claude.example/authorize?state=x",
      });
  });
  const ompAccountLogin = new OmpAccountLogin({
    runtime: omp,
    logger: pino({ level: "silent" }),
    openUrl: async (url) => void opened.push(url),
  });
  const daemon = await startDaemon({ cleanup: false, ompAccountLogin });
  const client = await connect(daemon, modern);
  const loginOn = () => client.getLastServerInfoMessage()?.features?.ompAccountLogin === true;
  client.observeEvents(["status.server_info"], { notifications: true });

  // No runtime negotiated yet: routing is off, so login is off too.
  expect(loginOn()).toBe(false);
  await expect(client.startOmpAccountLogin()).rejects.toBeInstanceOf(
    OmpAccountLoginUnsupportedError,
  );

  await daemon.routingFixture!.openAgent(daemon.staticDir);
  await expect.poll(loginOn).toBe(true);

  const started = await client.startOmpAccountLogin();
  expect(started.error).toBeNull();
  await expect
    .poll(async () => (await client.getOmpAccountLoginStatus()).status.state)
    .toBe("succeeded");
  expect(opened).toEqual(["https://claude.example/authorize?state=x"]);
  expect(omp.latestSession().loginRequests).toEqual(["anthropic"]);
});
