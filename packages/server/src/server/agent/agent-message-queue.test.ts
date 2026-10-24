import { afterEach, beforeEach, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager, type ManagedAgent } from "./agent-manager.js";
import { AgentMessageQueueDispatcher } from "./agent-message-queue.js";
import { toAgentPayload } from "./agent-projections.js";
import { AgentStorage } from "./agent-storage.js";
import type {
  AgentClient,
  AgentLaunchContext,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  SteerActiveTurnOptions,
  SteerResult,
} from "./agent-sdk-types.js";

const logger = createTestLogger();

const TEST_CAPABILITIES = {
  supportsStreaming: false,
  supportsSessionPersistence: true,
  supportsSessionListing: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;

interface StartedTurn {
  turnId: string;
  prompt: AgentPromptInput;
}

/**
 * A session whose turns stay open until the test completes them, so the
 * queue's idle-triggered dispatch can be observed deterministically.
 */
class HeldTurnSession implements AgentSession {
  readonly provider = "codex" as const;
  readonly capabilities = TEST_CAPABILITIES;
  readonly id: string;
  readonly turns: StartedTurn[] = [];
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private turnCounter = 0;
  private turnWaiters: Array<() => void> = [];

  constructor(sessionId: string) {
    this.id = sessionId;
  }

  async run(): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  async startTurn(prompt: AgentPromptInput): Promise<{ turnId: string }> {
    const turnId = `turn-${++this.turnCounter}`;
    this.turns.push({ turnId, prompt });
    // Deferred so the event lands after the manager has armed its foreground
    // waiter for this turn (same shape as the sessions in agent-manager.test.ts).
    setTimeout(() => {
      this.push({ type: "turn_started", provider: this.provider, turnId });
      for (const waiter of this.turnWaiters.splice(0)) waiter();
    }, 0);
    return { turnId };
  }

  completeTurn(turnId: string): void {
    this.push({ type: "turn_completed", provider: this.provider, turnId });
  }

  waitForNextTurn(): Promise<StartedTurn> {
    const seen = this.turns.length;
    const { promise, resolve } = Promise.withResolvers<StartedTurn>();
    this.turnWaiters.push(() => resolve(this.turns[seen]));
    return promise;
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  private push(event: AgentStreamEvent): void {
    for (const cb of this.subscribers) cb(event);
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

  async getRuntimeInfo() {
    return { provider: this.provider, sessionId: this.id, model: null, modeId: null };
  }

  async getAvailableModes() {
    return [];
  }

  async getCurrentMode() {
    return null;
  }

  async setMode(): Promise<void> {}

  getPendingPermissions() {
    return [];
  }

  async respondToPermission(): Promise<void> {}

  describePersistence() {
    return { provider: this.provider, sessionId: this.id };
  }

  async interrupt(): Promise<void> {}

  async close(): Promise<void> {}
}

class HeldTurnClient implements AgentClient {
  readonly provider = "codex" as const;
  readonly capabilities = TEST_CAPABILITIES;
  readonly sessions: HeldTurnSession[] = [];

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(_config: AgentSessionConfig): Promise<AgentSession> {
    const session = new HeldTurnSession(randomUUID());
    this.sessions.push(session);
    return session;
  }

  async resumeSession(
    handle: AgentPersistenceHandle,
    _config?: Partial<AgentSessionConfig>,
    _launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    const session = new HeldTurnSession(handle.sessionId ?? randomUUID());
    this.sessions.push(session);
    return session;
  }

  async fetchCatalog() {
    return { models: [], modes: [] };
  }

  get latest(): HeldTurnSession {
    const session = this.sessions.at(-1);
    if (!session) throw new Error("No session created yet");
    return session;
  }
}

function waitForLifecycle(
  manager: AgentManager,
  agentId: string,
  lifecycle: ManagedAgent["lifecycle"],
): Promise<void> {
  const current = manager.getAgent(agentId);
  if (current?.lifecycle === lifecycle) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  const unsubscribe = manager.subscribe(
    (event) => {
      if (
        event.type === "agent_state" &&
        event.agent.id === agentId &&
        event.agent.lifecycle === lifecycle
      ) {
        unsubscribe();
        resolve();
      }
    },
    { agentId, replayState: false },
  );
  return promise;
}

function promptText(prompt: AgentPromptInput): string {
  if (typeof prompt === "string") return prompt;
  return prompt
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
}

let workdir: string;
let storage: AgentStorage;
let client: HeldTurnClient;
let manager: AgentManager;
let dispatcher: AgentMessageQueueDispatcher;

beforeEach(async () => {
  workdir = mkdtempSync(join(tmpdir(), "agent-message-queue-"));
  storage = new AgentStorage(join(workdir, "agents"), logger);
  await storage.initialize();
  client = new HeldTurnClient();
  manager = new AgentManager({ clients: { codex: client }, registry: storage, logger });
  dispatcher = new AgentMessageQueueDispatcher({
    agentManager: manager,
    agentStorage: storage,
    logger,
  });
  dispatcher.attach();
});

afterEach(async () => {
  dispatcher.detach();
  for (const agent of manager.listAgents()) {
    await manager.closeAgent(agent.id).catch(() => undefined);
  }
  await storage.flush().catch(() => undefined);
  rmSync(workdir, { recursive: true, force: true });
});

async function createRunningAgent(): Promise<{ agentId: string; session: HeldTurnSession }> {
  const agent = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
    workspaceId: undefined,
  });
  const session = client.latest;
  const firstTurn = session.waitForNextTurn();
  // Drive the first turn through the manager so it is foreground-tracked.
  const iterator = manager.streamAgent(agent.id, "first");
  void (async () => {
    for await (const _ of iterator) {
      // drain
    }
  })();
  await firstTurn;
  await waitForLifecycle(manager, agent.id, "running");
  return { agentId: agent.id, session };
}

test("queued messages dispatch one at a time as each turn ends, and persist with the record", async () => {
  const { agentId, session } = await createRunningAgent();

  const first = await manager.addQueuedMessage(agentId, {
    text: "second message",
    images: [{ data: "aGVsbG8=", mimeType: "image/png" }],
  });
  const second = await manager.addQueuedMessage(agentId, { text: "third message" });

  const live = manager.getAgent(agentId);
  expect(live?.queuedMessages.map((item) => item.id)).toEqual([first.id, second.id]);
  expect(toAgentPayload(live!).queuedMessages).toEqual([
    {
      id: first.id,
      text: "second message",
      imageCount: 1,
      attachmentCount: 0,
      createdAt: first.createdAt,
    },
    {
      id: second.id,
      text: "third message",
      imageCount: 0,
      attachmentCount: 0,
      createdAt: second.createdAt,
    },
  ]);
  await storage.flush();
  const stored = await storage.get(agentId);
  expect(stored?.queuedMessages).toEqual([first, second]);

  // Nothing dispatches while the agent is still running.
  expect(session.turns).toHaveLength(1);

  const secondTurn = session.waitForNextTurn();
  session.completeTurn(session.turns[0].turnId);
  const started = await secondTurn;
  expect(promptText(started.prompt)).toBe("second message");
  expect(started.prompt).toContainEqual({ type: "image", data: "aGVsbG8=", mimeType: "image/png" });
  await waitForLifecycle(manager, agentId, "running");
  expect(manager.getAgent(agentId)?.queuedMessages.map((item) => item.id)).toEqual([second.id]);
  expect(session.turns).toHaveLength(2);

  const thirdTurn = session.waitForNextTurn();
  session.completeTurn(started.turnId);
  const startedThird = await thirdTurn;
  expect(startedThird.prompt).toBe("third message");
  await waitForLifecycle(manager, agentId, "running");
  expect(manager.getAgent(agentId)?.queuedMessages).toEqual([]);

  session.completeTurn(startedThird.turnId);
  await waitForLifecycle(manager, agentId, "idle");
  expect(session.turns).toHaveLength(3);
  await storage.flush();
  expect((await storage.get(agentId))?.queuedMessages).toEqual([]);
});

test("update and remove edit the shared list; remove returns the full entry", async () => {
  const { agentId, session } = await createRunningAgent();
  const first = await manager.addQueuedMessage(agentId, {
    text: "draft",
    attachments: [{ type: "text", mimeType: "text/plain", text: "ctx", contextKind: "file" }],
  });
  const second = await manager.addQueuedMessage(agentId, { text: "keep" });

  const updated = await manager.updateQueuedMessage(agentId, first.id, "edited");
  expect(updated.text).toBe("edited");
  expect(updated.attachments).toEqual(first.attachments);

  const removed = await manager.removeQueuedMessage(agentId, first.id);
  expect(removed).toEqual({ ...first, text: "edited" });
  expect(manager.getAgent(agentId)?.queuedMessages).toEqual([second]);

  await expect(manager.removeQueuedMessage(agentId, first.id)).rejects.toThrow(/not found/);
  await expect(manager.updateQueuedMessage(agentId, "missing", "x")).rejects.toThrow(/not found/);

  const nextTurn = session.waitForNextTurn();
  session.completeTurn(session.turns[0].turnId);
  const started = await nextTurn;
  expect(started.prompt).toBe("keep");
  expect(session.turns).toHaveLength(2);
});

test("send_now pops a specific entry and sends it into the active turn", async () => {
  const { agentId, session } = await createRunningAgent();
  const first = await manager.addQueuedMessage(agentId, { text: "first queued" });
  const second = await manager.addQueuedMessage(agentId, { text: "jump the line" });

  // The held session has no steerActiveTurn, so "steer" falls back to replacing
  // the run; either way the prompt reaches the provider exactly once.
  const nextTurn = session.waitForNextTurn();
  await dispatcher.sendNow(agentId, second.id, "steer");
  const started = await nextTurn;
  expect(started.prompt).toBe("jump the line");
  expect(manager.getAgent(agentId)?.queuedMessages).toEqual([first]);

  await expect(dispatcher.sendNow(agentId, "missing", "steer")).rejects.toThrow(/not found/);
});

test("a steered send_now records the entry as the turn's canonical user message", async () => {
  const { agentId, session } = await createRunningAgent();
  const steered: AgentPromptInput[] = [];
  const steerable = session as HeldTurnSession & {
    steerActiveTurn?: (
      prompt: AgentPromptInput,
      options: SteerActiveTurnOptions,
    ) => Promise<SteerResult>;
  };
  steerable.steerActiveTurn = async (prompt, options) => {
    if (options.expectedTurnId !== session.turns[0].turnId) return { status: "unavailable" };
    steered.push(prompt);
    return { status: "accepted" };
  };
  const queued = await manager.addQueuedMessage(agentId, { text: "steer me in" });

  await dispatcher.sendNow(agentId, queued.id, "steer");

  // The provider accepted the steer and does not echo it, so the manager's
  // record is the only user_message a client will ever see for this entry.
  expect(steered.map(promptText)).toEqual(["steer me in"]);
  expect(session.turns).toHaveLength(1);
  const userMessages = manager
    .getTimeline(agentId)
    .filter((item) => item.type === "user_message")
    .map((item) => ({ text: item.text, clientMessageId: item.clientMessageId }));
  expect(userMessages).toEqual([{ text: "steer me in", clientMessageId: queued.id }]);
  expect(manager.getAgent(agentId)?.queuedMessages).toEqual([]);
});

test("a message queued after the turn already ended dispatches on drainIfIdle", async () => {
  const { agentId, session } = await createRunningAgent();
  session.completeTurn(session.turns[0].turnId);
  await waitForLifecycle(manager, agentId, "idle");

  const nextTurn = session.waitForNextTurn();
  await manager.addQueuedMessage(agentId, { text: "late add" });
  dispatcher.drainIfIdle(agentId);
  const started = await nextTurn;
  expect(started.prompt).toBe("late add");
});

test("move reorders the shared list and clamps the target index", async () => {
  const { agentId } = await createRunningAgent();
  const a = await manager.addQueuedMessage(agentId, { text: "a" });
  const b = await manager.addQueuedMessage(agentId, { text: "b" });
  const c = await manager.addQueuedMessage(agentId, { text: "c" });
  const queuedIds = () => manager.getAgent(agentId)?.queuedMessages.map((item) => item.id);

  await manager.moveQueuedMessage(agentId, c.id, 0);
  expect(queuedIds()).toEqual([c.id, a.id, b.id]);

  await manager.moveQueuedMessage(agentId, c.id, 99);
  expect(queuedIds()).toEqual([a.id, b.id, c.id]);

  await manager.moveQueuedMessage(agentId, b.id, 0);
  expect(queuedIds()).toEqual([b.id, a.id, c.id]);
  expect(toAgentPayload(manager.getAgent(agentId)!).queuedMessages?.map((item) => item.id)).toEqual(
    [b.id, a.id, c.id],
  );

  await expect(manager.moveQueuedMessage(agentId, "missing", 0)).rejects.toThrow(
    `Queued message 'missing' not found on agent '${agentId}'`,
  );

  await storage.flush();
  expect((await storage.get(agentId))?.queuedMessages?.map((item) => item.id)).toEqual([
    b.id,
    a.id,
    c.id,
  ]);
});

test("clear empties the queue and returns the removed count", async () => {
  const { agentId } = await createRunningAgent();
  await manager.addQueuedMessage(agentId, { text: "one" });
  await manager.addQueuedMessage(agentId, { text: "two" });

  expect(await manager.clearQueuedMessages(agentId)).toBe(2);
  expect(manager.getAgent(agentId)?.queuedMessages).toEqual([]);
  expect(await manager.clearQueuedMessages(agentId)).toBe(0);

  await storage.flush();
  expect((await storage.get(agentId))?.queuedMessages).toEqual([]);
});

test("a paused queue does not drain on idle, send_now still works, and resuming drains the head", async () => {
  const { agentId, session } = await createRunningAgent();
  const first = await manager.addQueuedMessage(agentId, { text: "first queued" });
  const second = await manager.addQueuedMessage(agentId, { text: "second queued" });

  expect(await manager.setQueuePaused(agentId, true)).toBe(true);
  expect(toAgentPayload(manager.getAgent(agentId)!).queuePaused).toBe(true);
  await storage.flush();
  expect((await storage.get(agentId))?.queuePaused).toBe(true);

  session.completeTurn(session.turns[0].turnId);
  await waitForLifecycle(manager, agentId, "idle");
  dispatcher.drainIfIdle(agentId);
  // Queue mutations share the agent's lifecycle lane, so this runs after any
  // dispatch the idle state could have started.
  await manager.setQueuePaused(agentId, true);
  expect(manager.getAgent(agentId)?.queuedMessages).toEqual([first, second]);
  expect(session.turns).toHaveLength(1);

  const sentNow = session.waitForNextTurn();
  await dispatcher.sendNow(agentId, second.id, "steer");
  expect((await sentNow).prompt).toBe("second queued");
  expect(manager.getAgent(agentId)?.queuedMessages).toEqual([first]);

  session.completeTurn(session.turns[1].turnId);
  await waitForLifecycle(manager, agentId, "idle");
  await manager.setQueuePaused(agentId, true);
  expect(manager.getAgent(agentId)?.queuedMessages).toEqual([first]);
  expect(session.turns).toHaveLength(2);

  const resumedTurn = session.waitForNextTurn();
  expect(await manager.setQueuePaused(agentId, false)).toBe(false);
  dispatcher.drainIfIdle(agentId);
  expect((await resumedTurn).prompt).toBe("first queued");
  await waitForLifecycle(manager, agentId, "running");
  expect(manager.getAgent(agentId)?.queuedMessages).toEqual([]);
  expect(toAgentPayload(manager.getAgent(agentId)!)).not.toHaveProperty("queuePaused");
});

test("the queue survives a daemon restart and drains once the agent is resumed", async () => {
  const { agentId, session } = await createRunningAgent();
  const queued = await manager.addQueuedMessage(agentId, { text: "after restart" });
  await storage.flush();
  // Simulate the daemon dying mid-turn: detach the dispatcher so nothing
  // drains, close the live agent, and bring up a fresh manager on the same store.
  dispatcher.detach();
  session.completeTurn(session.turns[0].turnId);
  await manager.closeAgent(agentId);
  await storage.flush();

  const restartedClient = new HeldTurnClient();
  const restarted = new AgentManager({
    clients: { codex: restartedClient },
    registry: storage,
    logger,
  });
  const restartedDispatcher = new AgentMessageQueueDispatcher({
    agentManager: restarted,
    agentStorage: storage,
    logger,
  });
  restartedDispatcher.attach();
  try {
    const record = await storage.get(agentId);
    expect(record?.queuedMessages).toEqual([queued]);
    const resumed = await restarted.resumeAgentFromPersistence(
      { provider: "codex", sessionId: session.id },
      { cwd: workdir, provider: "codex" },
      agentId,
      { queuedMessages: record?.queuedMessages ?? [] },
    );
    expect(resumed.queuedMessages).toEqual([queued]);
    const started = await restartedClient.latest.waitForNextTurn();
    expect(started.prompt).toBe("after restart");
    await waitForLifecycle(restarted, agentId, "running");
    expect(restarted.getAgent(agentId)?.queuedMessages).toEqual([]);
  } finally {
    restartedDispatcher.detach();
    for (const agent of restarted.listAgents()) {
      await restarted.closeAgent(agent.id).catch(() => undefined);
    }
  }
});

test("a paused queue stays paused across a daemon restart", async () => {
  const { agentId, session } = await createRunningAgent();
  const queued = await manager.addQueuedMessage(agentId, { text: "held over restart" });
  await manager.setQueuePaused(agentId, true);
  dispatcher.detach();
  session.completeTurn(session.turns[0].turnId);
  await manager.closeAgent(agentId);
  await storage.flush();

  const restartedClient = new HeldTurnClient();
  const restarted = new AgentManager({
    clients: { codex: restartedClient },
    registry: storage,
    logger,
  });
  const restartedDispatcher = new AgentMessageQueueDispatcher({
    agentManager: restarted,
    agentStorage: storage,
    logger,
  });
  restartedDispatcher.attach();
  try {
    const record = await storage.get(agentId);
    expect(record?.queuePaused).toBe(true);
    const resumed = await restarted.resumeAgentFromPersistence(
      { provider: "codex", sessionId: session.id },
      { cwd: workdir, provider: "codex" },
      agentId,
      { queuedMessages: record?.queuedMessages ?? [], queuePaused: record?.queuePaused ?? false },
    );
    expect(resumed.queuePaused).toBe(true);
    await waitForLifecycle(restarted, agentId, "idle");
    restartedDispatcher.drainIfIdle(agentId);
    await restarted.setQueuePaused(agentId, true);
    expect(restarted.getAgent(agentId)?.queuedMessages).toEqual([queued]);
    expect(restartedClient.latest.turns).toHaveLength(0);

    const resumedTurn = restartedClient.latest.waitForNextTurn();
    await restarted.setQueuePaused(agentId, false);
    restartedDispatcher.drainIfIdle(agentId);
    expect((await resumedTurn).prompt).toBe("held over restart");
  } finally {
    restartedDispatcher.detach();
    for (const agent of restarted.listAgents()) {
      await restarted.closeAgent(agent.id).catch(() => undefined);
    }
  }
});
