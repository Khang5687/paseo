import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import pino from "pino";
import { afterEach, describe, expect, test } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import type { OmpAccountRoutingMutation, OmpRoutingBlock } from "@getpaseo/protocol/messages";
import { OmpAccountRoutingUnsupportedError } from "@getpaseo/client";
import type { OmpRpcAdmitDecision } from "../agent/providers/omp/rpc-types.js";
import {
  ROUTING_MODEL,
  RoutingPool,
  routingRef,
} from "../agent/providers/omp/test-utils/fake-omp.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

// Final synthetic acceptance for OMP global account routing (umbrella "Behavioral acceptance", host
// contract executable_fixture_path). Everything runs through a versioned client against a real
// daemon, the real OmpCliRuntime/bridge/authority and a scripted JSONL child, with a temp home and
// loopback port zero. Native provider billing enforcement, native ranking and checkpointed resume
// are the native runtime's own behavior: oh-my-pi omp#7-#10 tests cover them, not this file.

const OPUS = "claude-opus-4-5";
const HOUR = 3_600_000;
const modern = { owned_subscriptions: true };

const ref = (row: number) => routingRef(row);
const block = (
  scope: OmpRoutingBlock["scope"],
  resetAt: number | null,
  limitId = "5h",
): OmpRoutingBlock => ({
  limitId,
  scope,
  resetAt,
  observedAt: Date.now(),
  source: "provider-rejection",
  confirmed: true,
});
const shared = { kind: "shared" } as const;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed())
    await Promise.resolve(cleanup()).catch(() => undefined);
});

class LogSink extends Writable {
  lines: string[] = [];
  override _write(chunk: Buffer, _enc: string, done: () => void) {
    this.lines.push(chunk.toString());
    done();
  }
}

type Admit = Extract<OmpRpcAdmitDecision, { kind: "admit" }>;

async function setup(count: number, options: Parameters<typeof createTestPaseoDaemon>[0] = {}) {
  const pool = new RoutingPool(count);
  const logs = new LogSink();
  const logger = pino({ level: "debug" }, logs);
  const daemon = await createTestPaseoDaemon({
    mcpEnabled: false,
    logger,
    ompRouting: pool.options(),
    ...options,
  });
  cleanups.push(daemon.close);
  const fixture = daemon.routingFixture!;
  const client = await connect(daemon);
  client.observeEvents(["status.server_info"], { notifications: true });
  const frames: string[] = [];
  client.subscribeRawMessages((message) => frames.push(JSON.stringify(message)));

  let op = 0;
  type Agent = Awaited<ReturnType<typeof fixture.openAgent>>;
  const project = () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paseo-routing-project-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  };
  const openAgent = async (cwd = project()) => {
    const agent = await fixture.openAgent(cwd);
    await expect.poll(() => featureOn(client)).toBe(true);
    return agent;
  };
  const request = (agent: Agent, model = ROUTING_MODEL, extra: { previousWaitId?: string } = {}) =>
    fixture.requestAdmission({
      runtimeInstanceId: agent.runtimeInstanceId,
      operationId: `op-${++op}`,
      sessionId: `native-${agent.agentId}`,
      modelId: model,
      ...extra,
    });
  const admitted = async (agent: Agent, model = ROUTING_MODEL): Promise<Admit> => {
    const decision = await request(agent, model);
    expect(decision.kind).toBe("admit");
    return decision as Admit;
  };
  const state = async () => (await client.getOmpAccountRoutingState()).state;
  const mutate = async (command: OmpAccountRoutingMutation) => {
    const result = await client.mutateOmpAccountRouting({
      expectedPolicyRevision: (await state()).policy.policyRevision,
      command,
    });
    expect(result.error).toBeNull();
    return result.state;
  };
  return {
    pool,
    daemon,
    fixture,
    client,
    frames,
    logs,
    openAgent,
    request,
    admitted,
    state,
    mutate,
  };
}

async function connect(daemon: TestPaseoDaemon, capabilities: Record<string, boolean> = modern) {
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.8.0",
    capabilities,
  });
  cleanups.push(() => client.close());
  await client.connect();
  return client;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const refs = (list: Array<{ ref: { nativeRowId: number } }>) => list.map((a) => a.ref.nativeRowId);

describe("pools, stable identity and manual selection", () => {
  test.each([2, 5, 6])(
    "%i accounts keep identity across reorder, duplicate labels and metadata edits",
    async (count) => {
      const h = await setup(count);
      // Two rows share one display label: refs, not labels, are the identity.
      h.pool.update(1, { email: "same@example.test", organizationName: "Shared Org" });
      h.pool.update(2, { email: "same@example.test", organizationName: "Shared Org" });
      const agent = await h.openAgent();
      const before = await h.state();
      expect(before.accounts).toHaveLength(count);
      expect(
        new Set(before.accounts.map((a) => `${a.ref.storeNamespace}:${a.ref.nativeRowId}`)).size,
      ).toBe(count);
      const duplicates = before.accounts.filter((a) => a.ref.nativeRowId <= 2);
      expect(duplicates[0].label).toBe(duplicates[1].label);
      expect(duplicates[0].identityLabel).not.toBe(duplicates[1].identityLabel);

      await h.mutate({ kind: "select", account: ref(2) });

      // Native lists the same identities in another order and edits the selected row's metadata.
      h.pool.reverseOrder();
      h.pool.update(2, { email: "renamed@example.test", organizationName: "Other Org" });
      const decision = await h.admitted(agent);
      expect(decision.accountRef).toEqual(ref(2));
      const after = await h.state();
      expect(after.policy.current).toEqual(ref(2));
      expect(after.policy.priorityOrder).toEqual(before.policy.priorityOrder);
      expect(after.accounts.find((a) => a.ref.nativeRowId === 2)?.label).toBe(
        "renamed@example.test",
      );

      // A new account appends to policy without rebalancing or changing the selection.
      h.pool.add(count + 1);
      await h.admitted(agent);
      const grown = await h.state();
      expect(grown.policy.current).toEqual(ref(2));
      expect(refs(grown.policy.priorityOrder.map((r) => ({ ref: r })))).toEqual([
        ...refs(before.policy.priorityOrder.map((r) => ({ ref: r }))),
        count + 1,
      ]);
      expect(
        grown.policy.inclusion.find((e) => e.account.nativeRowId === count + 1)?.included,
      ).toBe(true);
    },
  );

  test("manual select B mid-task: in-flight A finishes on A, the next call from two projects admits B", async () => {
    const h = await setup(2);
    const p1 = await h.openAgent();
    const p2 = await h.openAgent();
    await h.mutate({ kind: "select", account: ref(1) });
    const first = await h.admitted(p1);
    expect(first.accountRef).toEqual(ref(1));
    h.fixture.started({
      runtimeInstanceId: p1.runtimeInstanceId,
      admission: first,
      operationId: "op-1",
      sessionId: `native-${p1.agentId}`,
      modelId: ROUTING_MODEL,
    });

    const sent = p1.child.received.length;
    const selected = await h.mutate({ kind: "select", account: ref(2) });
    expect(selected.policy.current).toEqual(ref(2));
    expect(selected.policy.selectionGeneration).toBeGreaterThan(first.selectionGeneration);

    // The request already in flight is not moved.
    await expect.poll(async () => servingOf(await h.state())).toEqual([[1, "serving"]]);

    // Next internal model call from each project admits B: no prompt, restart or new child.
    const [second, third] = await Promise.all([h.admitted(p1), h.admitted(p2)]);
    expect(second.accountRef).toEqual(ref(2));
    expect(third.accountRef).toEqual(ref(2));
    h.fixture.outcome({
      runtimeInstanceId: p1.runtimeInstanceId,
      admission: first,
      operationId: "op-1",
      sessionId: `native-${p1.agentId}`,
      modelId: ROUTING_MODEL,
    });
    await expect.poll(async () => activeRowsOf(await h.state())).toEqual([2, 2]);
    expect(h.fixture.children).toHaveLength(2);
    const added = p1.child.received.slice(sent).map((f) => f.type);
    expect(added.filter((type) => !String(type).startsWith("account.routing."))).toEqual([]);
    expect(h.pool.size).toBe(2);
  });
});

describe("auto fallback", () => {
  test("priority edits and excluding the current account never switch it", async () => {
    const h = await setup(3);
    const agent = await h.openAgent();
    await h.mutate({ kind: "select", account: ref(2) });
    const generation = (await h.state()).policy.selectionGeneration;
    await h.mutate({ kind: "move_priority", account: ref(3), direction: "up" });
    await h.mutate({ kind: "move_priority", account: ref(2), direction: "down" });
    await h.mutate({ kind: "set_inclusion", account: ref(2), included: false });
    await h.mutate({ kind: "set_auto", enabled: false });
    await h.mutate({ kind: "set_auto", enabled: true });
    expect((await h.admitted(agent)).accountRef).toEqual(ref(2));
    const after = (await h.state()).policy;
    expect(after.current).toEqual(ref(2));
    expect(after.selectionGeneration).toBe(generation);
  });

  test("exhaustion picks by capacity, then priority, and never returns to a recovered account", async () => {
    const h = await setup(3);
    h.pool.update(2, { used: 0.8 });
    h.pool.update(3, { used: 0.2 });
    const agent = await h.openAgent();
    await h.mutate({ kind: "select", account: ref(1) });
    const first = await h.admitted(agent);
    h.fixture.outcome({
      runtimeInstanceId: agent.runtimeInstanceId,
      admission: first,
      operationId: "op-1",
      sessionId: `native-${agent.agentId}`,
      modelId: ROUTING_MODEL,
      quotaBlocks: [block(shared, Date.now() + HOUR)],
    });
    await expect.poll(async () => (await h.state()).accounts[0].quotaBlocks.length).toBe(1);

    // C has more headroom than higher-priority B.
    const fallback = await h.admitted(agent);
    expect(fallback.accountRef).toEqual(ref(3));
    expect((await h.state()).policy.current).toEqual(ref(3));

    // A recovers (native reports no block) but the selection stays put.
    h.pool.update(1, { blocks: [], used: 0 });
    const stayed = await h.admitted(agent);
    expect(stayed.accountRef).toEqual(ref(3));
    expect((await h.state()).policy.current).toEqual(ref(3));
  });

  test("equal headroom falls back by priority order", async () => {
    const h = await setup(3);
    const agent = await h.openAgent();
    await h.mutate({ kind: "move_priority", account: ref(3), direction: "up" });
    await h.mutate({ kind: "select", account: ref(1) });
    h.pool.update(1, { blocks: [block(shared, Date.now() + HOUR)] });
    const decision = await h.admitted(agent);
    // Order is now 1, 3, 2: the higher-priority candidate wins the tie.
    expect(decision.accountRef).toEqual(ref(3));
  });

  test("an excluded current account keeps serving but is never chosen automatically; manual select of an excluded one is allowed", async () => {
    const h = await setup(3);
    const agent = await h.openAgent();
    await h.mutate({ kind: "select", account: ref(1) });
    await h.mutate({ kind: "set_inclusion", account: ref(1), included: false });
    expect((await h.admitted(agent)).accountRef).toEqual(ref(1));
    expect((await h.state()).policy.current).toEqual(ref(1));

    // Fall off the excluded account; auto then never returns to it, even recovered.
    h.pool.update(1, { blocks: [block(shared, Date.now() + HOUR)] });
    expect((await h.admitted(agent)).accountRef).toEqual(ref(2));
    h.pool.update(1, { blocks: [], used: 0 });
    h.pool.update(2, { blocks: [block(shared, Date.now() + HOUR)] });
    expect((await h.admitted(agent)).accountRef).toEqual(ref(3));

    // Excluded B can still be selected by hand, and then serves.
    await h.mutate({ kind: "set_inclusion", account: ref(2), included: false });
    h.pool.update(2, { blocks: [] });
    const manual = await h.mutate({ kind: "select", account: ref(2) });
    expect(manual.policy.current).toEqual(ref(2));
    expect((await h.admitted(agent)).accountRef).toEqual(ref(2));
  });

  test("model-specific exhaustion moves the global selection only for the exhausted model", async () => {
    const h = await setup(2);
    const agent = await h.openAgent();
    await h.mutate({ kind: "select", account: ref(2) });
    h.pool.update(2, {
      blocks: [block({ kind: "model", modelId: OPUS }, Date.now() + HOUR, "weekly-opus")],
    });
    // Sonnet is untouched on B; Opus falls back to A and the choice becomes global.
    expect((await h.admitted(agent, ROUTING_MODEL)).accountRef).toEqual(ref(2));
    expect((await h.admitted(agent, OPUS)).accountRef).toEqual(ref(1));
    const after = await h.state();
    expect(after.policy.current).toEqual(ref(1));
    expect(after.accounts.find((a) => a.ref.nativeRowId === 2)?.quotaBlocks).toHaveLength(1);
    expect(after.accounts.find((a) => a.ref.nativeRowId === 1)?.quotaBlocks).toHaveLength(0);
  });
});

describe("pause and resume", () => {
  test("auto off pauses on exhaustion, stays paused after reset, and a manual action releases it", async () => {
    const h = await setup(2);
    const agent = await h.openAgent();
    await h.mutate({ kind: "select", account: ref(1) });
    await h.mutate({ kind: "set_auto", enabled: false });
    h.pool.update(1, { blocks: [block(shared, Date.now() + 250)] });
    const decision = await h.request(agent);
    expect(decision).toMatchObject({ kind: "wait", reason: "auto_disabled" });
    const waitId = (decision as { waitId: string }).waitId;
    expect((await h.state()).pausedRequests).toMatchObject([{ requiresUserAction: true }]);

    // The reset passes and native reports it; auto-off work does not wake itself.
    await sleep(400);
    h.pool.update(1, { blocks: [] });
    expect(agent.child.framesOfType("account.routing.resume")).toEqual([]);

    await h.mutate({ kind: "select", account: ref(1) });
    await agent.child.waitForFrame("account.routing.resume", (f) => f.waitId === waitId);
    const resumed = await h.request(agent, ROUTING_MODEL, { previousWaitId: waitId });
    expect(resumed).toMatchObject({ kind: "admit", accountRef: ref(1) });
  });

  test("all exhausted pauses once, wakes on reset, and cancelled or archived work stays dead", async () => {
    const h = await setup(2);
    // Native already reports both exhausted when the runtimes attach: no metadata-change wake.
    const resetAt = Date.now() + 1500;
    h.pool.update(1, { blocks: [block(shared, resetAt)] });
    h.pool.update(2, { blocks: [block(shared, resetAt)] });
    const live = await h.openAgent();
    const cancelled = await h.openAgent();
    const archived = await h.openAgent();

    const waits = await Promise.all([live, cancelled, archived].map((agent) => h.request(agent)));
    for (const wait of waits)
      expect(wait).toMatchObject({
        kind: "wait",
        reason: "all_unavailable",
        reconsiderAt: resetAt,
      });
    const [liveWait, cancelledWait] = waits.map((w) => (w as { waitId: string }).waitId);
    expect((await h.state()).pausedRequests).toHaveLength(3);
    // No cycling or API fallback while paused: the only frames are the one-time resume hint.
    expect((await h.state()).activeRequests).toEqual([]);

    h.fixture.cancel({
      runtimeInstanceId: cancelled.runtimeInstanceId,
      operationId: "op-2",
      waitId: cancelledWait,
    });
    await h.client.archiveAgent(archived.agentId);
    await expect.poll(async () => (await h.state()).pausedRequests.length).toBe(1);
    expect(Date.now()).toBeLessThan(resetAt);

    // Reset: the timer hints exactly the live wait. Native revalidates and re-admits.
    await live.child.waitForFrame("account.routing.resume", (f) => f.waitId === liveWait);
    h.pool.update(1, { blocks: [] });
    h.pool.update(2, { blocks: [] });
    const resumed = await h.request(live, ROUTING_MODEL, { previousWaitId: liveWait });
    expect(resumed.kind).toBe("admit");
    expect((await h.state()).pausedRequests).toMatchObject([{ recoveredAt: expect.any(Number) }]);

    // A late re-admit for the cancelled wait is refused: nothing is revived.
    const revived = await h.request(cancelled, ROUTING_MODEL, { previousWaitId: cancelledWait });
    expect(revived).toMatchObject({ kind: "refuse", reason: "cancelled" });
    expect(cancelled.child.framesOfType("account.routing.resume")).toEqual([]);
    expect(archived.child.framesOfType("account.routing.resume")).toEqual([]);
    expect((await h.state()).activeRequests).toHaveLength(1);
  });

  test("re-enabling an account wakes a waiter without a reset", async () => {
    const h = await setup(2);
    const agent = await h.openAgent();
    await h.mutate({ kind: "select", account: ref(1) });
    await h.mutate({ kind: "set_inclusion", account: ref(2), included: false });
    h.pool.update(1, { blocks: [block(shared, Date.now() + HOUR)] });
    h.pool.update(2, { blocks: [] });
    const wait = await h.request(agent);
    expect(wait).toMatchObject({ kind: "wait", reason: "all_unavailable" });
    // The excluded B cannot be chosen; waiting is the honest answer.
    await h.mutate({ kind: "set_inclusion", account: ref(2), included: true });
    const waitId = (wait as { waitId: string }).waitId;
    await agent.child.waitForFrame("account.routing.resume", (f) => f.waitId === waitId);
    const resumed = await h.request(agent, ROUTING_MODEL, { previousWaitId: waitId });
    expect(resumed).toMatchObject({ kind: "admit", accountRef: ref(2) });
  });
});

describe("billing, concurrency and capability", () => {
  test.each([
    ["enabled", "billing_enabled"],
    ["unknown", "billing_unknown"],
    ["expired", "billing_unknown"],
  ] as const)("%s billing metadata refuses model dispatch", async (billing, reason) => {
    const h = await setup(2);
    const agent = await h.openAgent();
    await h.mutate({ kind: "select", account: ref(1) });
    h.pool.update(1, { billing });
    expect(await h.request(agent)).toMatchObject({ kind: "refuse", reason });
    expect((await h.state()).activeRequests).toEqual([]);
    // Fresh disabled metadata is the only way back in.
    h.pool.update(1, { billing: "disabled" });
    expect((await h.admitted(agent)).accountRef).toEqual(ref(1));
  });

  test("concurrent failures commit one transition; a stale failure cannot override a newer manual selection", async () => {
    const h = await setup(3);
    const p1 = await h.openAgent();
    const p2 = await h.openAgent();
    await h.mutate({ kind: "select", account: ref(1) });
    const a1 = await h.admitted(p1);
    const a2 = await h.admitted(p2);
    const sessionOf = (agent: typeof p1) => `native-${agent.agentId}`;
    const exhaust = [block(shared, Date.now() + HOUR)];
    h.fixture.outcome({
      runtimeInstanceId: p1.runtimeInstanceId,
      admission: a1,
      operationId: "op-1",
      sessionId: sessionOf(p1),
      modelId: ROUTING_MODEL,
      quotaBlocks: exhaust,
    });
    h.fixture.outcome({
      runtimeInstanceId: p2.runtimeInstanceId,
      admission: a2,
      operationId: "op-2",
      sessionId: sessionOf(p2),
      modelId: ROUTING_MODEL,
      quotaBlocks: exhaust,
    });
    await expect.poll(async () => (await h.state()).activeRequests).toEqual([]);

    const before = await h.state();
    const [x, y] = await Promise.all([h.admitted(p1), h.admitted(p2)]);
    expect(x.accountRef).toEqual(y.accountRef);
    expect(x.accountRef).not.toEqual(ref(1));
    const after = await h.state();
    expect(after.policy.policyRevision).toBe(before.policy.policyRevision + 1);
    expect(after.policy.current).toEqual(x.accountRef);

    // Manual C wins; a late failure of an old A admission only marks A.
    const manual = await h.mutate({ kind: "select", account: ref(3) });
    const old = await h.admitted(p1); // admitted on C now
    expect(old.accountRef).toEqual(ref(3));
    h.fixture.outcome({
      runtimeInstanceId: p1.runtimeInstanceId,
      admission: { ...a1 },
      operationId: "op-1",
      sessionId: sessionOf(p1),
      modelId: ROUTING_MODEL,
      quotaBlocks: [block(shared, Date.now() + HOUR, "weekly")],
    });
    await sleep(50);
    const settled = await h.state();
    expect(settled.policy.current).toEqual(ref(3));
    expect(settled.policy.selectionGeneration).toBe(manual.policy.selectionGeneration);
    expect((await h.admitted(p2)).accountRef).toEqual(ref(3));
  });

  test("a runtime without managed admission keeps the feature off and is never pinned or restarted around", async () => {
    const h = await setup(2);
    h.fixture.setRuntimeCapability(() => ({ completeCoverage: false }));
    await expect(h.fixture.openAgent(h.daemon.staticDir)).rejects.toThrow("unsupported_runtime");
    expect(featureOn(h.client)).toBe(false);
    await expect(h.client.getOmpAccountRoutingState()).rejects.toBeInstanceOf(
      OmpAccountRoutingUnsupportedError,
    );
    // One launch attempt; native saw configure and nothing that pins, reloads or switches.
    expect(h.fixture.children).toHaveLength(1);
    const types = h.fixture.child.received.map((f) => String(f.type));
    expect(types.filter((type) => /pin|restart|reload|switch|admit/.test(type))).toEqual([]);

    // A later launch against a capable binary turns it on with no daemon restart; a further
    // incapable launch cannot disturb it.
    h.fixture.setRuntimeCapability(undefined);
    const agent = await h.openAgent();
    expect((await h.admitted(agent)).kind).toBe("admit");
    h.fixture.setRuntimeCapability(() => ({ completeCoverage: false }));
    await expect(h.fixture.openAgent(h.daemon.staticDir)).rejects.toThrow("unsupported_runtime");
    expect(featureOn(h.client)).toBe(true);
    expect((await h.admitted(agent)).kind).toBe("admit");
  });
});

describe("persistence and reconnect", () => {
  test("restart restores order, inclusion, current and auto by stable identity; stale revisions are rejected", async () => {
    const h = await setup(3, { cleanup: false });
    const agent = await h.openAgent();
    await h.mutate({ kind: "move_priority", account: ref(3), direction: "up" });
    await h.mutate({ kind: "set_inclusion", account: ref(2), included: false });
    await h.mutate({ kind: "select", account: ref(2) });
    await h.mutate({ kind: "set_auto", enabled: false });
    const saved = await h.state();
    await h.admitted(agent);

    const second = await connect(h.daemon);
    const staleRevision = saved.policy.policyRevision - 1;
    const stale = await second.mutateOmpAccountRouting({
      expectedPolicyRevision: staleRevision,
      command: { kind: "set_auto", enabled: true },
    });
    expect(stale.error?.code).toBe("conflict");
    expect(stale.state.policy.autoEnabled).toBe(false);

    await h.daemon.close();
    // Native now lists the identities in the opposite order; identity is the ref, not the position.
    h.pool.reverseOrder();
    const restarted = await createTestPaseoDaemon({
      mcpEnabled: false,
      ompRouting: h.pool.options(),
      paseoHomeRoot: h.daemon.paseoHome.replace(/\/\.paseo$/, ""),
    });
    cleanups.push(restarted.close);
    const again = await connect(restarted);
    again.observeEvents(["status.server_info"], { notifications: true });
    await restarted.routingFixture!.openAgent(restarted.staticDir);
    await expect.poll(() => featureOn(again)).toBe(true);
    const restored = (await again.getOmpAccountRoutingState()).state.policy;
    expect(restored).toMatchObject({
      policyRevision: saved.policy.policyRevision,
      current: ref(2),
      autoEnabled: false,
      priorityOrder: saved.policy.priorityOrder,
    });
    expect(restored.inclusion).toEqual(saved.policy.inclusion);
  });
});

describe("authority and secrecy", () => {
  async function fakeHub(daemon: TestPaseoDaemon, permissions: string[]) {
    const admin = await connect(daemon, {});
    const hub = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        response.setHeader("content-type", "application/json");
        const enrollment = JSON.parse(body || "{}");
        const address = hub.address();
        if (!address || typeof address === "string") return response.end("{}");
        response.end(
          JSON.stringify({
            daemonId: enrollment.daemonId,
            permissions: enrollment.permissions,
            webSocketUrl: `ws://127.0.0.1:${address.port}/socket`,
          }),
        );
      });
    });
    const wss = new WebSocketServer({ server: hub });
    wss.on("headers", (headers) => headers.push("x-paseo-session-protocol: 1"));
    const inbound: Array<{ message?: { type?: string; payload?: { code?: string } } }> = [];
    const connected = new Promise<WebSocket>((resolve) =>
      wss.once("connection", (socket) => {
        socket.on("message", (data) => inbound.push(JSON.parse(data.toString())));
        resolve(socket);
      }),
    );
    await new Promise<void>((resolve) => hub.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => {
      await admin.disconnectHub(true).catch(() => undefined);
      wss.clients.forEach((c) => c.terminate());
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => hub.close(() => r()));
    });
    const address = hub.address();
    if (!address || typeof address === "string") throw new Error("Missing local Hub address");
    await admin.connectHub(
      `http://127.0.0.1:${address.port}`,
      "local-fixture-token",
      permissions as never,
    );
    const socket = await connected;
    socket.send(
      JSON.stringify({
        type: "hello",
        clientId: "restricted",
        clientType: "hub",
        protocolVersion: 1,
        capabilities: modern,
      }),
    );
    await expect.poll(() => inbound.length).toBeGreaterThan(0);
    return { socket, inbound };
  }

  test.each([[["hub.execute"]], [["workspace.read", "workspace.write", "workspace.manage"]]])(
    "a live principal holding only %j is denied routing reads, mutations and updates",
    async (permissions) => {
      const h = await setup(2);
      await h.openAgent();
      const peer = await fakeHub(h.daemon, permissions);
      const send = (message: Record<string, unknown>) =>
        peer.socket.send(JSON.stringify({ type: "session", message }));
      peer.inbound.length = 0;
      const current = await h.state();
      send({ type: "account.routing.get_state.request", requestId: "r1", subscribe: {} });
      send({
        type: "account.routing.mutate.request",
        requestId: "r2",
        expectedPolicyRevision: current.policy.policyRevision,
        command: { kind: "set_auto", enabled: false },
      });
      await expect.poll(() => errorsOf(peer.inbound)).toBe(2);
      expect(peer.inbound.map((f) => f.message?.payload?.code)).toEqual([
        "access_denied",
        "access_denied",
      ]);
      expect((await h.state()).policy.autoEnabled).toBe(true);

      // A change by the owner never reaches the restricted peer.
      await h.mutate({ kind: "select", account: ref(2) });
      await sleep(100);
      expect(JSON.stringify(peer.inbound)).not.toMatch(
        /account\.routing\.(state|get_state\.response|mutate\.response)/,
      );
    },
  );

  test("no token or secret value appears in client frames, native frames or logs", async () => {
    const canary = "sk-ant-oat01-CANARY-synthetic-not-real";
    const previous = { a: process.env.ANTHROPIC_API_KEY, b: process.env.CLAUDE_CODE_OAUTH_TOKEN };
    process.env.ANTHROPIC_API_KEY = canary;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = canary;
    cleanups.push(() => {
      for (const [key, value] of [
        ["ANTHROPIC_API_KEY", previous.a],
        ["CLAUDE_CODE_OAUTH_TOKEN", previous.b],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    const h = await setup(2);
    const agent = await h.openAgent();
    await h.mutate({ kind: "select", account: ref(2) });
    const admission = await h.admitted(agent);
    h.fixture.outcome({
      runtimeInstanceId: agent.runtimeInstanceId,
      admission,
      operationId: "op-1",
      sessionId: `native-${agent.agentId}`,
      modelId: ROUTING_MODEL,
      quotaBlocks: [block(shared, Date.now() + HOUR)],
    });
    h.pool.update(1, { billing: "enabled" });
    await h.request(agent);
    await h.state();

    const wire = h.frames.join("\n");
    const native = JSON.stringify(h.fixture.children.flatMap((child) => child.received));
    const logs = h.logs.lines.join("");
    expect(wire).toContain("account.routing");
    const secret =
      /sk-ant|oat01|CANARY|bearer\s|access[_-]?token|refresh[_-]?token|api[_-]?key|"secret"|"password"/i;
    for (const [name, text] of [
      ["wire", wire],
      ["native", native],
      ["logs", logs],
    ] as const) {
      expect(text, name).not.toMatch(secret);
    }
  });
});

const servingOf = (state: {
  activeRequests: Array<{ accountRef: { nativeRowId: number }; phase: string }>;
}) => state.activeRequests.map((r) => [r.accountRef.nativeRowId, r.phase]);
const activeRowsOf = (state: { activeRequests: Array<{ accountRef: { nativeRowId: number } }> }) =>
  state.activeRequests.map((r) => r.accountRef.nativeRowId).sort();
const errorsOf = (frames: Array<{ message?: { type?: string } }>) =>
  frames.filter((f) => f.message?.type === "rpc_error").length;

function featureOn(client: DaemonClient) {
  return client.getLastServerInfoMessage()?.features?.ompAccountRouting === true;
}
