import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

import { createTestAgentMessages } from "../test-utils/agent-messages.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import { ForkHandleRefusedError } from "./fork-handle.js";
import { AskAgentThreads, COPY_BLOCKED_MESSAGE, type AskThreadSettings } from "./ask-agent.js";
import { ProviderSnapshotManager } from "./provider-snapshot-manager.js";
import { createPaseoToolCatalog } from "./tools/paseo-tools.js";
import type {
  AgentClient,
  AgentLaunchContext,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  AgentUsage,
  ForkedNativeSession,
} from "./agent-sdk-types.js";

const CAPABILITIES = {
  supportsStreaming: false,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;

type CopyBehavior = "answer" | "asks-permission" | "hangs";

interface CopyScript {
  behavior: CopyBehavior;
  /** Text of the copy's answer for a given turn (1-based). */
  reply: (turn: number, sessionId: string) => string;
  usage: AgentUsage | undefined;
  /** The copy compacts its context while answering this turn. */
  compactOnTurn: number | null;
  onTurnStarted: (() => void) | undefined;
  /** The copy takes this long (fake-timer time) to answer. */
  replyDelayMs: number;
}

function defaultScript(): CopyScript {
  return {
    behavior: "answer",
    reply: (turn, sessionId) => `answer ${turn} from ${sessionId}`,
    usage: { contextWindowUsedTokens: 10, contextWindowMaxTokens: 100 },
    compactOnTurn: null,
    onTurnStarted: undefined,
    replyDelayMs: 0,
  };
}

/** One provider session. Each turn answers from the script; a source session just answers. */
class ScriptedSession implements AgentSession {
  readonly provider = "codex" as const;
  readonly capabilities = CAPABILITIES;
  readonly prompts: string[] = [];
  readonly permissionResponses: AgentPermissionResponse[] = [];
  closed = false;
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private turn = 0;

  constructor(
    readonly id: string,
    readonly config: Partial<AgentSessionConfig>,
    private readonly script: CopyScript,
  ) {}

  async run(): Promise<AgentRunResult> {
    throw new Error("run is not used by the manager");
  }

  async startTurn(prompt: AgentPromptInput): Promise<{ turnId: string }> {
    this.prompts.push(String(prompt));
    const turnId = `turn-${++this.turn}`;
    // Deferred like a provider: the manager has the turn id before the turn's events arrive.
    setImmediate(() => {
      this.emit({ type: "turn_started", provider: this.provider, turnId });
      this.script.onTurnStarted?.();
      if (this.script.behavior === "answer") {
        if (this.script.replyDelayMs > 0) {
          setTimeout(() => this.finish(turnId), this.script.replyDelayMs);
        } else {
          this.finish(turnId);
        }
      }
      if (this.script.behavior === "asks-permission") {
        this.emit({
          type: "permission_requested",
          provider: this.provider,
          turnId,
          request: { id: "perm-1", provider: this.provider, name: "Bash", kind: "tool" },
        });
      }
    });
    return { turnId };
  }

  private finish(turnId: string): void {
    if (this.script.compactOnTurn === this.turn) {
      this.emit({
        type: "timeline",
        provider: this.provider,
        turnId,
        item: { type: "compaction", status: "completed", trigger: "auto" },
      });
    }
    this.emit({
      type: "timeline",
      provider: this.provider,
      turnId,
      item: { type: "assistant_message", text: this.script.reply(this.turn, this.id) },
    });
    this.emit({
      type: "turn_completed",
      provider: this.provider,
      turnId,
      ...(this.script.usage ? { usage: this.script.usage } : {}),
    });
  }

  private emit(event: AgentStreamEvent): void {
    for (const callback of this.subscribers) callback(event);
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

  async getRuntimeInfo() {
    return { provider: this.provider, sessionId: this.id, model: null, modeId: null };
  }

  async getAvailableModes() {
    return [];
  }

  async getCurrentMode() {
    return this.config.modeId ?? null;
  }

  async setMode(): Promise<void> {}

  getPendingPermissions() {
    return [];
  }

  async respondToPermission(requestId: string, response: AgentPermissionResponse): Promise<void> {
    this.permissionResponses.push(response);
    this.emit({
      type: "permission_resolved",
      provider: this.provider,
      requestId,
      resolution: response,
    });
    this.finish(`turn-${this.turn}`);
  }

  describePersistence(): AgentPersistenceHandle {
    return { provider: this.provider, sessionId: this.id, metadata: { cwd: this.config.cwd } };
  }

  async interrupt(): Promise<void> {
    this.emit({
      type: "turn_canceled",
      provider: this.provider,
      reason: "interrupted",
      turnId: `turn-${this.turn}`,
    });
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class ForkingClient implements AgentClient {
  readonly provider = "codex" as const;
  readonly capabilities = CAPABILITIES;
  readonly sessions = new Map<string, ScriptedSession>();
  /** Agent id each copy session was launched under: the id its Paseo tools run as. */
  readonly agentIdBySession = new Map<string, string>();
  readonly discarded: string[] = [];
  readonly discardedHandles: string[] = [];
  copy = defaultScript();
  failHandleDiscard = false;
  forks = 0;
  private sources = 0;
  /** Holds forkNativeSession until released, to close a thread while its copy is being made. */
  forkGate: Promise<void> | null = null;
  /** Holds fork.discard() until released. */
  discardGate: Promise<void> | null = null;
  failForkDiscard = false;
  refuseHandleDiscard = false;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async fetchCatalog() {
    return { models: [], modes: [] };
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    const id = this.sources++ === 0 ? "source-session" : `source-session-${this.sources}`;
    const session = new ScriptedSession(id, config, defaultScript());
    this.sessions.set(session.id, session);
    return session;
  }

  async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    const session = new ScriptedSession(
      handle.sessionId,
      { ...(handle.metadata as Partial<AgentSessionConfig>), ...overrides },
      this.copy,
    );
    this.sessions.set(session.id, session);
    if (launchContext?.agentId) this.agentIdBySession.set(session.id, launchContext.agentId);
    return session;
  }

  async forkNativeSession(handle: AgentPersistenceHandle): Promise<ForkedNativeSession> {
    const sessionId = `${handle.sessionId}-copy-${++this.forks}`;
    await this.forkGate;
    return {
      handle: { ...handle, sessionId },
      readOnlyModeId: "read-only",
      discard: async () => {
        await this.discardGate;
        if (this.failForkDiscard) throw new Error("disk is busy");
        this.discarded.push(sessionId);
      },
    };
  }

  async discardNativeFork(handle: AgentPersistenceHandle): Promise<void> {
    if (this.refuseHandleDiscard) throw new ForkHandleRefusedError("bad handle");
    if (this.failHandleDiscard) throw new Error("provider is down");
    this.discardedHandles.push(handle.sessionId);
  }
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.useRealTimers();
  const pending = cleanups.splice(0);
  for (let i = pending.length - 1; i >= 0; i--) await pending[i]?.();
});

async function scenario(options: { settings?: Partial<AskThreadSettings> } = {}) {
  const workdir = mkdtempSync(join(tmpdir(), "ask-agent-"));
  const logger = createTestLogger();
  const client = new ForkingClient();
  const clients = { codex: client };
  const registry = new AgentStorage(join(workdir, "agents"), logger);
  const manager = new AgentManager({ clients, registry, logger });
  const threads = new AskAgentThreads(manager, logger, {
    paseoHome: workdir,
    settings: options.settings,
  });
  manager.setAgentArchivedCallback((agentId) => threads.handleAgentArchived(agentId));
  const source = await manager.createAgent(
    { provider: "codex", cwd: workdir, model: "source-model", title: "builder" },
    undefined,
    { workspaceId: undefined },
  );
  await manager.runAgent(source.id, "remember the plan");
  cleanups.push(async () => {
    await threads.closeAll();
    await manager.closeAgent(source.id).catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  });
  const sourceSession = client.sessions.get("source-session")!;
  const readOpenForks = (): unknown =>
    JSON.parse(readFileSync(join(workdir, "ask-agent-open-forks.json"), "utf8"));
  return {
    client,
    clients,
    manager,
    threads,
    logger,
    registry,
    workdir,
    sourceId: source.id,
    sourceSession,
    readOpenForks,
  };
}

const COPY = "source-session-copy-1";

test("the first ask forks once; later asks reach the same copy, which remembers earlier rounds", async () => {
  const { client, threads, sourceId, sourceSession } = await scenario();

  const first = await threads.ask({
    agentId: sourceId,
    question: "What is the plan?",
    askerId: "asker-1",
    askedBy: "planner",
  });
  // No threadId: the asker's open thread with this agent is reused.
  const second = await threads.ask({
    agentId: sourceId,
    question: "And then?",
    askerId: "asker-1",
  });
  const third = await threads.ask({
    agentId: sourceId,
    question: "Why?",
    askerId: "asker-1",
    threadId: first.threadId,
  });

  expect(second.threadId).toBe(first.threadId);
  expect(third.threadId).toBe(first.threadId);
  expect(client.forks).toBe(1);
  expect(first.answer).toBe(`answer 1 from ${COPY}`);
  expect(third.answer).toBe(`answer 3 from ${COPY}`);
  expect(third.thread).toMatchObject({ status: "open", round: 3, maxRounds: 10, roundsLeft: 7 });
  expect(sourceSession.prompts).toEqual(["remember the plan"]);
  expect(client.copy.reply(1, "x")).toBe("answer 1 from x");
});

test("the opening prompt names the asker by title and id, once; later rounds send only the question", async () => {
  const { client, threads, sourceId } = await scenario();

  await threads.ask({
    agentId: sourceId,
    question: "What is the plan?",
    askerId: "asker-1",
    askedBy: "planner",
  });
  await threads.ask({ agentId: sourceId, question: "And then?", askerId: "asker-1" });

  const copy = client.sessions.get(COPY)!;
  expect(copy.config).toMatchObject({ internal: true, modeId: "read-only" });
  expect(copy.prompts).toHaveLength(2);
  expect(copy.prompts[0]).toContain('"planner"');
  expect(copy.prompts[0]).toContain("asker-1");
  expect(copy.prompts[0]).toContain("What is the plan?");
  expect(copy.prompts[1]).toBe("And then?");
});

test("each asker gets its own thread with the same agent, and only its owner can use it", async () => {
  const { client, threads, sourceId } = await scenario();

  const a = await threads.ask({ agentId: sourceId, question: "Q", askerId: "asker-1" });
  const b = await threads.ask({ agentId: sourceId, question: "Q", askerId: "asker-2" });

  expect(b.threadId).not.toBe(a.threadId);
  expect(client.forks).toBe(2);
  await expect(
    threads.ask({ agentId: sourceId, question: "Q", askerId: "asker-2", threadId: a.threadId }),
  ).rejects.toThrow("belongs to another asker");
});

test("the copy answers on the source's model", async () => {
  const { client, threads, sourceId } = await scenario();

  await threads.ask({ agentId: sourceId, question: "Q", askerId: "asker-1" });

  expect(client.sessions.get(COPY)!.config.model).toBe("source-model");
});

test("the last round says so and closes the thread", async () => {
  const { client, threads, sourceId, readOpenForks } = await scenario({
    settings: { maxRounds: 2 },
  });

  const one = await threads.ask({ agentId: sourceId, question: "Q1", askerId: "asker-1" });
  const two = await threads.ask({ agentId: sourceId, question: "Q2", askerId: "asker-1" });

  expect(one.thread).toMatchObject({ status: "open", roundsLeft: 1 });
  expect(two.thread).toMatchObject({
    status: "closed",
    round: 2,
    roundsLeft: 0,
    closeReason: "round limit reached",
  });
  expect(two.thread.notes).toContain("This was the last round (2 of 2). The thread is closed.");
  expect(client.sessions.get(COPY)!.closed).toBe(true);
  expect(client.discarded).toEqual([COPY]);
  expect(readOpenForks()).toEqual([]);
  await expect(
    threads.ask({ agentId: sourceId, question: "Q3", askerId: "asker-1", threadId: two.threadId }),
  ).rejects.toThrow("closed (round limit reached)");
});

test("the asker can close a thread; the copy and its provider state are deleted", async () => {
  const { client, manager, threads, sourceId, readOpenForks } = await scenario();
  const { threadId } = await threads.ask({ agentId: sourceId, question: "Q", askerId: "asker-1" });
  expect(readOpenForks()).toEqual([
    { threadId, handle: expect.objectContaining({ sessionId: COPY }) },
  ]);

  const closed = await threads.close({ agentId: sourceId, threadId, askerId: "asker-1" });

  expect(closed.thread).toMatchObject({ status: "closed", closeReason: "closed by the asker" });
  expect(client.sessions.get(COPY)!.closed).toBe(true);
  expect(client.discarded).toEqual([COPY]);
  expect(manager.listAgents().map((agent) => agent.id)).toEqual([sourceId]);
  expect(readOpenForks()).toEqual([]);
  await expect(
    threads.ask({ agentId: sourceId, question: "Q", askerId: "asker-1", threadId }),
  ).rejects.toThrow("closed (closed by the asker)");
});

test("status reports rounds without asking, for open and closed threads", async () => {
  const { client, threads, sourceId } = await scenario();
  const { threadId } = await threads.ask({ agentId: sourceId, question: "Q", askerId: "asker-1" });

  const open = threads.status({ agentId: sourceId, askerId: "asker-1" });
  await threads.close({ agentId: sourceId, threadId, askerId: "asker-1" });
  const closed = threads.status({ agentId: sourceId, threadId, askerId: "asker-1" });

  expect(open.thread).toMatchObject({ threadId, status: "open", round: 1, roundsLeft: 9 });
  expect(closed.thread).toMatchObject({ threadId, status: "closed" });
  expect(client.sessions.get(COPY)!.prompts).toHaveLength(1);
});

test("a thread with no round for the idle limit closes itself", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { client, threads, sourceId } = await scenario({
    settings: { idleTimeoutMs: 10 * 60_000 },
  });
  const asking = threads.ask({ agentId: sourceId, question: "Q", askerId: "asker-1" });
  await vi.advanceTimersByTimeAsync(5);
  const { threadId } = await asking;

  await vi.advanceTimersByTimeAsync(10 * 60_000 - 10);
  expect(threads.status({ agentId: sourceId, threadId, askerId: "asker-1" }).thread.status).toBe(
    "open",
  );
  await vi.advanceTimersByTimeAsync(10);

  const status = threads.status({ agentId: sourceId, threadId, askerId: "asker-1" });
  expect(status.thread).toMatchObject({ status: "closed", closeReason: "idle too long" });
  expect(client.sessions.get(COPY)!.closed).toBe(true);
  expect(client.discarded).toEqual([COPY]);
});

test("a round restarts the idle clock", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { threads, sourceId } = await scenario({ settings: { idleTimeoutMs: 1000 } });
  const first = threads.ask({ agentId: sourceId, question: "Q1", askerId: "asker-1" });
  await vi.advanceTimersByTimeAsync(5);
  const { threadId } = await first;
  await vi.advanceTimersByTimeAsync(900);
  const second = threads.ask({ agentId: sourceId, question: "Q2", askerId: "asker-1", threadId });
  await vi.advanceTimersByTimeAsync(5);
  await second;

  await vi.advanceTimersByTimeAsync(900);

  expect(threads.status({ agentId: sourceId, threadId, askerId: "asker-1" }).thread.status).toBe(
    "open",
  );
});

test("archiving the asked agent closes its threads", async () => {
  const { client, manager, threads, sourceId } = await scenario();
  const { threadId } = await threads.ask({ agentId: sourceId, question: "Q", askerId: "asker-1" });

  await manager.archiveAgent(sourceId);

  expect(threads.status({ agentId: sourceId, threadId, askerId: "asker-1" }).thread).toMatchObject({
    status: "closed",
    closeReason: "an agent was archived",
  });
  expect(client.sessions.get(COPY)!.closed).toBe(true);
  expect(client.discarded).toEqual([COPY]);
});

test("archiving the asking agent closes its threads", async () => {
  const { client, manager, threads, sourceId, workdir } = await scenario();
  const asker = await manager.createAgent(
    { provider: "codex", cwd: workdir, title: "planner" },
    undefined,
    { workspaceId: undefined },
  );
  await manager.runAgent(asker.id, "hello");
  const { threadId } = await threads.ask({ agentId: sourceId, question: "Q", askerId: asker.id });

  await manager.archiveAgent(asker.id);

  expect(threads.status({ agentId: sourceId, threadId, askerId: asker.id }).thread.status).toBe(
    "closed",
  );
  expect(client.discarded).toEqual([COPY]);
});

test("a full daemon refuses a new copy, and a close frees the slot", async () => {
  const { threads, sourceId } = await scenario({ settings: { maxOpenThreads: 1 } });
  const first = await threads.ask({ agentId: sourceId, question: "Q", askerId: "asker-1" });

  await expect(
    threads.ask({ agentId: sourceId, question: "Q", askerId: "asker-2" }),
  ).rejects.toThrow("too many open copies; close one or use send_agent_prompt");
  // A thread that already exists still works when the daemon is full.
  await threads.ask({
    agentId: sourceId,
    question: "Q2",
    askerId: "asker-1",
    threadId: first.threadId,
  });
  await threads.close({ agentId: sourceId, threadId: first.threadId, askerId: "asker-1" });

  await expect(
    threads.ask({ agentId: sourceId, question: "Q", askerId: "asker-2" }),
  ).resolves.toBeTruthy();
});

test("a new daemon deletes the forks an earlier one left behind", async () => {
  const { client, manager, logger, workdir, threads, sourceId, readOpenForks } = await scenario();
  await threads.ask({ agentId: sourceId, question: "Q", askerId: "asker-1" });
  expect(readOpenForks()).toHaveLength(1);

  // The first daemon dies without closing: a second one starts on the same home.
  const restarted = new AskAgentThreads(manager, logger, { paseoHome: workdir });
  await restarted.discardLeftovers();

  expect(client.discardedHandles).toEqual([COPY]);
  expect(readOpenForks()).toEqual([]);
});

test("a fork that cannot be deleted at startup stays recorded for the next start", async () => {
  const { client, manager, logger, workdir, threads, sourceId, readOpenForks } = await scenario();
  await threads.ask({ agentId: sourceId, question: "Q", askerId: "asker-1" });
  client.failHandleDiscard = true;
  const restarted = new AskAgentThreads(manager, logger, { paseoHome: workdir });

  await restarted.discardLeftovers();

  expect(readOpenForks()).toHaveLength(1);
});

test("stopping the daemon closes every thread", async () => {
  const { client, threads, sourceId, readOpenForks } = await scenario();
  await threads.ask({ agentId: sourceId, question: "Q", askerId: "asker-1" });
  await threads.ask({ agentId: sourceId, question: "Q", askerId: "asker-2" });

  await threads.closeAll();

  expect(client.discarded.sort()).toEqual([COPY, "source-session-copy-2"]);
  expect(readOpenForks()).toEqual([]);
});

test("a reply longer than the cap is cut, with a note on how to read the rest", async () => {
  const { client, threads, sourceId } = await scenario({ settings: { replyCharLimit: 50 } });
  client.copy.reply = () => "x".repeat(120);

  const cut = await threads.ask({ agentId: sourceId, question: "Q", askerId: "asker-1" });

  expect(cut.answer.startsWith("x".repeat(50))).toBe(true);
  expect(cut.answer).not.toContain("x".repeat(51));
  expect(cut.answer).toContain("[Reply cut at 50 of 120 characters.");
  expect(cut.answer).toContain(`threadId ${cut.threadId}`);
  expect(cut.thread.notes[0]).toContain("Reply cut");
});

test("a reply at the cap is returned whole", async () => {
  const { client, threads, sourceId } = await scenario({ settings: { replyCharLimit: 50 } });
  client.copy.reply = () => "y".repeat(50);

  const whole = await threads.ask({ agentId: sourceId, question: "Q", askerId: "asker-1" });

  expect(whole.answer).toBe("y".repeat(50));
});

test("the asker is warned once when the copy passes 80% of its context", async () => {
  const { client, threads, sourceId } = await scenario();
  client.copy.usage = { contextWindowUsedTokens: 85, contextWindowMaxTokens: 100 };

  const one = await threads.ask({ agentId: sourceId, question: "Q1", askerId: "asker-1" });
  const two = await threads.ask({ agentId: sourceId, question: "Q2", askerId: "asker-1" });

  expect(one.thread.notes.join("\n")).toContain("85% full");
  expect(two.thread.notes.join("\n")).not.toContain("full");
});

test("a copy below 80% gets no warning", async () => {
  const { client, threads, sourceId } = await scenario();
  client.copy.usage = { contextWindowUsedTokens: 79, contextWindowMaxTokens: 100 };

  const one = await threads.ask({ agentId: sourceId, question: "Q1", askerId: "asker-1" });

  expect(one.thread.notes).toEqual([]);
});

test("a copy whose size the provider does not report says so", async () => {
  const { client, threads, sourceId } = await scenario();
  client.copy.usage = undefined;

  const one = await threads.ask({ agentId: sourceId, question: "Q1", askerId: "asker-1" });

  expect(one.thread.notes).toContain("Copy size unknown.");
});

test("a copy that compacts closes the thread with a plain warning", async () => {
  const { client, threads, sourceId } = await scenario();
  client.copy.compactOnTurn = 2;

  const one = await threads.ask({ agentId: sourceId, question: "Q1", askerId: "asker-1" });
  const two = await threads.ask({ agentId: sourceId, question: "Q2", askerId: "asker-1" });

  expect(one.thread.status).toBe("open");
  expect(two.thread).toMatchObject({
    status: "closed",
    closeReason: "the copy got full and compacted",
  });
  expect(two.thread.notes).toContain(
    "copy got full and started forgetting; start a new thread or use send_agent_prompt",
  );
  expect(client.discarded).toEqual([COPY]);
});

test("each answer counts the turns the source finished since the copy was made", async () => {
  const { manager, threads, sourceId } = await scenario();

  const one = await threads.ask({ agentId: sourceId, question: "Q1", askerId: "asker-1" });
  await manager.runAgent(sourceId, "keep working");
  await manager.runAgent(sourceId, "keep working again");
  const two = await threads.ask({ agentId: sourceId, question: "Q2", askerId: "asker-1" });

  expect(one.thread.sourceTurnsSince).toBe(0);
  expect(two.thread.sourceTurnsSince).toBe(2);
});

test("rounds more than five minutes apart note the cost of a pause", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const { threads, sourceId } = await scenario();

  const one = await threads.ask({ agentId: sourceId, question: "Q1", askerId: "asker-1" });
  vi.setSystemTime(Date.now() + 4 * 60_000);
  const quick = await threads.ask({ agentId: sourceId, question: "Q2", askerId: "asker-1" });
  vi.setSystemTime(Date.now() + 6 * 60_000);
  const slow = await threads.ask({ agentId: sourceId, question: "Q3", askerId: "asker-1" });

  expect(one.thread.notes.join("\n")).not.toContain("minutes passed");
  expect(quick.thread.notes.join("\n")).not.toContain("minutes passed");
  expect(slow.thread.notes.join("\n")).toContain("6 minutes passed since the last round");
});

test("a provider that cannot fork gets a hint, and the failed attempt holds no slot", async () => {
  const { client, threads, sourceId, sourceSession } = await scenario({
    settings: { maxOpenThreads: 1 },
  });
  Object.defineProperty(client, "forkNativeSession", { value: undefined, configurable: true });

  await expect(
    threads.ask({ agentId: sourceId, question: "Status?", askerId: "asker-1" }),
  ).rejects.toThrow("This agent can't be copied; use send_agent_prompt.");
  expect(sourceSession.prompts).toEqual(["remember the plan"]);

  Reflect.deleteProperty(client, "forkNativeSession");
  await expect(
    threads.ask({ agentId: sourceId, question: "Status?", askerId: "asker-1" }),
  ).resolves.toBeTruthy();
});

test("the copy's approval requests are denied instead of waiting for a human", async () => {
  const { client, threads, sourceId } = await scenario();
  client.copy.behavior = "asks-permission";

  const { answer } = await threads.ask({
    agentId: sourceId,
    question: "Run the tests?",
    askerId: "a",
  });

  expect(answer).toBe(`answer 1 from ${COPY}`);
  expect(client.sessions.get(COPY)!.permissionResponses).toEqual([
    expect.objectContaining({ behavior: "deny" }),
  ]);
});

test("an abandoned question cancels the copy's turn and deletes the copy", async () => {
  const { client, threads, sourceId } = await scenario();
  client.copy.behavior = "hangs";
  const caller = new AbortController();
  client.copy.onTurnStarted = () => caller.abort(new Error("caller went away"));

  await expect(
    threads.ask({
      agentId: sourceId,
      question: "Status?",
      askerId: "asker-1",
      signal: caller.signal,
    }),
  ).rejects.toThrow("caller went away");

  expect(client.sessions.get(COPY)!.closed).toBe(true);
  expect(client.discarded).toEqual([COPY]);
});

test("a second question while the copy is still answering is refused", async () => {
  const { client, threads, sourceId } = await scenario();
  let release: () => void = () => {};
  client.copy.behavior = "hangs";
  client.copy.onTurnStarted = () => release();
  const first = threads.ask({
    agentId: sourceId,
    question: "Q1",
    askerId: "asker-1",
    timeoutMs: 50,
  });
  first.catch(() => undefined);
  await new Promise<void>((resolve) => {
    release = resolve;
  });

  await expect(
    threads.ask({ agentId: sourceId, question: "Q2", askerId: "asker-1" }),
  ).rejects.toThrow("still answering");
  await expect(first).rejects.toThrow("did not answer");
});

// Copy lockdown: the copy runs with its own agent id as the Paseo tool caller.
async function lockdownScenario(settings: Partial<AskThreadSettings> = {}) {
  const base = await scenario({ settings });
  const agentStorage = base.registry;
  const providerSnapshotManager = new ProviderSnapshotManager({
    logger: base.logger,
    extraClients: base.clients,
  });
  const agentMessages = createTestAgentMessages({
    agentManager: base.manager,
    agentStorage,
    logger: base.logger,
  });
  const dependencies = {
    agentManager: base.manager,
    agentStorage,
    providerSnapshotManager,
    logger: base.logger,
    agentMessages: () => agentMessages,
    askThreads: () => base.threads,
  };
  await base.threads.ask({ agentId: base.sourceId, question: "Q", askerId: "asker-1" });
  const copyAgentId = base.client.agentIdBySession.get(COPY)!;
  return {
    ...base,
    copyAgentId,
    copyCatalog: createPaseoToolCatalog({ ...dependencies, callerAgentId: copyAgentId }),
    sourceCatalog: createPaseoToolCatalog({ ...dependencies, callerAgentId: base.sourceId }),
    dependencies,
  };
}

const READ_ONLY_TOOLS = new Set([
  "list_hosts",
  "list_workspaces",
  "get_agent_status",
  "list_agents",
  "get_agent_activity",
  "list_workspace_scripts",
  "list_terminals",
  "capture_terminal",
  "list_schedules",
  "inspect_schedule",
  "schedule_logs",
  "list_providers",
  "list_models",
  "list_profiles",
  "inspect_provider",
  "list_pending_permissions",
]);

test("a copy cannot call ask_agent, send_agent_prompt, or any other mutating Paseo tool", async () => {
  const { copyCatalog } = await lockdownScenario();

  const blocked: string[] = [];
  for (const [name, tool] of copyCatalog.tools) {
    if (READ_ONLY_TOOLS.has(name)) continue;
    await expect(tool.handler({}, {}), name).rejects.toThrow(COPY_BLOCKED_MESSAGE);
    blocked.push(name);
  }

  expect(blocked).toEqual(
    expect.arrayContaining(["ask_agent", "send_agent_prompt", "create_agent"]),
  );
  expect(blocked.length).toBeGreaterThan(20);
});

test("a copy may still read through Paseo tools", async () => {
  const { copyCatalog } = await lockdownScenario();

  for (const name of READ_ONLY_TOOLS) {
    const tool = copyCatalog.tools.get(name);
    if (!tool) continue;
    const outcome = await tool.handler({}, {}).then(
      () => "",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(outcome, name).not.toContain(COPY_BLOCKED_MESSAGE);
  }
});

test("the copy keeps the source's tool list, and the source itself is not locked", async () => {
  const { copyCatalog, sourceCatalog } = await lockdownScenario();

  expect([...copyCatalog.tools.keys()]).toEqual([...sourceCatalog.tools.keys()]);
  // Not-found is the proof: the call reached the tool instead of the copy guard.
  const sourceAsk = await sourceCatalog.tools
    .get("ask_agent")!
    .handler({ agentId: "nobody", question: "Q" }, {})
    .then(
      () => "",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
  expect(sourceAsk).not.toContain(COPY_BLOCKED_MESSAGE);
});

test("ask_agent as a tool: follow-ups with threadId, status, close, and the asker named by title and id", async () => {
  const { client, manager, dependencies, sourceId, workdir } = await lockdownScenario();
  const asker = await manager.createAgent(
    { provider: "codex", cwd: workdir, title: "planner" },
    undefined,
    { workspaceId: undefined },
  );
  await manager.runAgent(asker.id, "hello");
  const catalog = createPaseoToolCatalog({ ...dependencies, callerAgentId: asker.id });
  const call = async (input: Record<string, unknown>) =>
    (await catalog.executeTool("ask_agent", { agentId: sourceId, ...input })).structuredContent as {
      threadId?: string;
      answer: string | null;
      thread?: { status: string; round: number; roundsLeft: number };
    };

  const one = await call({ question: "What is the plan?" });
  const two = await call({ question: "And then?", threadId: one.threadId });
  const status = await call({ status: true, threadId: one.threadId });
  const closed = await call({ close: true, threadId: one.threadId });

  expect(two.answer).toBe("answer 2 from source-session-copy-2");
  expect(two.threadId).toBe(one.threadId);
  expect(status).toMatchObject({
    answer: null,
    thread: { status: "open", round: 2, roundsLeft: 8 },
  });
  expect(closed.thread?.status).toBe("closed");
  const copy = client.sessions.get("source-session-copy-2")!;
  expect(copy.prompts[0]).toContain('"planner"');
  expect(copy.prompts[0]).toContain(asker.id);
  await expect(catalog.executeTool("ask_agent", { agentId: sourceId })).rejects.toThrow(
    "question is required",
  );
});

// --- Review fixes -------------------------------------------------------------------------

function gate(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("closing a thread while its copy is still being made undoes the copy and frees the slot", async () => {
  const { client, threads, sourceId, readOpenForks } = await scenario({
    settings: { maxOpenThreads: 1 },
  });
  const forkGate = gate();
  client.forkGate = forkGate.promise;
  const asking = threads.ask({ agentId: sourceId, question: "Q", askerId: "asker-1" });
  asking.catch(() => undefined);

  // The target is archived while forkAgentSession has not returned yet.
  const closing = threads.handleAgentArchived(sourceId);
  forkGate.release();
  await closing;

  await expect(asking).rejects.toThrow("an agent was archived");
  expect(client.discarded).toEqual([COPY]);
  expect(client.sessions.has(COPY)).toBe(false);
  expect(readOpenForks()).toEqual([]);
  client.forkGate = null;
  await expect(
    threads.ask({ agentId: sourceId, question: "Q", askerId: "asker-2" }),
  ).resolves.toBeTruthy();
});

test("a caller with no identity gets a one-shot answer: one round, then the copy is gone", async () => {
  const { client, threads, sourceId, readOpenForks } = await scenario({
    settings: { maxOpenThreads: 1 },
  });

  const first = await threads.act({ agentId: sourceId, question: "Q1" });
  const second = await threads.act({ agentId: sourceId, question: "Q2" });

  expect(first).toEqual({ answer: `answer 1 from ${COPY}` });
  // A fresh copy each time: nothing carried over.
  expect(second).toEqual({ answer: "answer 1 from source-session-copy-2" });
  expect(client.discarded).toEqual([COPY, "source-session-copy-2"]);
  expect(client.sessions.get(COPY)!.closed).toBe(true);
  expect(readOpenForks()).toEqual([]);
  expect(() => threads.status({ agentId: sourceId })).toThrow("No open thread");
  await expect(threads.act({ agentId: sourceId, question: "Q", threadId: "abc" })).rejects.toThrow(
    "No open thread",
  );
});

test("a daemon that cannot read or write its fork records still starts and still answers", async () => {
  const { manager, logger, workdir, sourceId } = await scenario();
  const notADirectory = join(workdir, "plain-file");
  writeFileSync(notADirectory, "x");
  const broken = new AskAgentThreads(manager, logger, { paseoHome: notADirectory });

  await expect(broken.loadLeftovers()).resolves.toBeUndefined();
  await expect(broken.discardLeftovers()).resolves.toBeUndefined();
  await expect(
    broken.ask({ agentId: sourceId, question: "Q", askerId: "asker-1" }),
  ).resolves.toMatchObject({ answer: expect.any(String) });
  await broken.closeAll();
});

test("a fork whose delete failed keeps its record, and the next start retries it", async () => {
  const { client, manager, logger, workdir, threads, sourceId, readOpenForks } = await scenario();
  const { threadId } = await threads.ask({ agentId: sourceId, question: "Q", askerId: "asker-1" });
  client.failForkDiscard = true;

  await threads.close({ agentId: sourceId, threadId, askerId: "asker-1" });

  expect(readOpenForks()).toEqual([
    { threadId, handle: expect.objectContaining({ sessionId: COPY }), attempts: 0 },
  ]);
  const restarted = new AskAgentThreads(manager, logger, { paseoHome: workdir });
  await restarted.discardLeftovers();
  expect(client.discardedHandles).toEqual([COPY]);
  expect(readOpenForks()).toEqual([]);
});

test("a fork the provider keeps failing to delete is given up on after five starts", async () => {
  const { client, manager, logger, workdir, threads, sourceId, readOpenForks } = await scenario();
  const { threadId } = await threads.ask({ agentId: sourceId, question: "Q", askerId: "asker-1" });
  client.failForkDiscard = true;
  await threads.close({ agentId: sourceId, threadId, askerId: "asker-1" });
  client.failHandleDiscard = true;

  const attempts: unknown[] = [];
  for (let start = 0; start < 5; start++) {
    await new AskAgentThreads(manager, logger, { paseoHome: workdir }).discardLeftovers();
    attempts.push((readOpenForks() as Array<{ attempts?: number }>)[0]?.attempts);
  }

  expect(attempts).toEqual([1, 2, 3, 4, undefined]);
  expect(readOpenForks()).toEqual([]);
});

test("a record the provider refuses is dropped at once, not retried", async () => {
  const { client, manager, logger, workdir, threads, sourceId, readOpenForks } = await scenario();
  await threads.ask({ agentId: sourceId, question: "Q", askerId: "asker-1" });
  client.refuseHandleDiscard = true;

  await new AskAgentThreads(manager, logger, { paseoHome: workdir }).discardLeftovers();

  expect(readOpenForks()).toEqual([]);
});

test("damaged entries in the fork record file are skipped; valid ones are still deleted", async () => {
  const { client, manager, logger, workdir, readOpenForks } = await scenario();
  const file = join(workdir, "ask-agent-open-forks.json");
  writeFileSync(
    file,
    JSON.stringify([
      { threadId: 1, handle: "nope" },
      "text",
      { threadId: "t-ok", handle: { provider: "codex", sessionId: "leftover-1" } },
    ]),
  );
  const restarted = new AskAgentThreads(manager, logger, { paseoHome: workdir });

  await restarted.discardLeftovers();
  expect(client.discardedHandles).toEqual(["leftover-1"]);
  expect(readOpenForks()).toEqual([]);

  writeFileSync(file, "{ not json");
  await expect(
    new AskAgentThreads(manager, logger, { paseoHome: workdir }).discardLeftovers(),
  ).resolves.toBeUndefined();
});

test("an empty question is refused before anything is forked", async () => {
  const { client, threads, sourceId } = await scenario();

  await expect(
    threads.act({ agentId: sourceId, question: "   ", askerId: "asker-1" }),
  ).rejects.toThrow("question is required");
  await expect(threads.act({ agentId: sourceId, question: "" })).rejects.toThrow(
    "question is required",
  );
  expect(client.forks).toBe(0);
});

test("closing a thread while a round is running cancels the round and deletes the copy", async () => {
  const { client, threads, sourceId } = await scenario();
  client.copy.behavior = "hangs";
  const started = gate();
  client.copy.onTurnStarted = started.release;
  const asking = threads.ask({ agentId: sourceId, question: "Q", askerId: "asker-1" });
  asking.catch(() => undefined);
  await started.promise;

  await threads.close({ agentId: sourceId, askerId: "asker-1" });

  await expect(asking).rejects.toThrow("closed by the asker");
  expect(client.sessions.get(COPY)!.closed).toBe(true);
  expect(client.discarded).toEqual([COPY]);
});

test("two first asks at once share one copy; the second is told to wait", async () => {
  const { client, threads, sourceId } = await scenario();
  const forkGate = gate();
  client.forkGate = forkGate.promise;

  const first = threads.ask({ agentId: sourceId, question: "Q1", askerId: "asker-1" });
  const second = threads.ask({ agentId: sourceId, question: "Q2", askerId: "asker-1" });
  second.catch(() => undefined);
  forkGate.release();

  await expect(second).rejects.toThrow("still answering");
  await expect(first).resolves.toMatchObject({ answer: `answer 1 from ${COPY}` });
  expect(client.forks).toBe(1);
});

test("the idle clock does not run while a round is in flight", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { client, threads, sourceId } = await scenario({ settings: { idleTimeoutMs: 1000 } });
  const one = threads.ask({ agentId: sourceId, question: "Q1", askerId: "asker-1" });
  await vi.advanceTimersByTimeAsync(5);
  const { threadId } = await one;
  await vi.advanceTimersByTimeAsync(900);
  client.copy.replyDelayMs = 5000;

  const two = threads.ask({ agentId: sourceId, question: "Q2", askerId: "asker-1", threadId });
  await vi.advanceTimersByTimeAsync(5100);

  await expect(two).resolves.toMatchObject({ answer: `answer 2 from ${COPY}` });
  expect(threads.status({ agentId: sourceId, threadId, askerId: "asker-1" }).thread.status).toBe(
    "open",
  );
});

test("a closing thread answers closed at once but holds its slot and record until the fork is gone", async () => {
  const { client, threads, sourceId, readOpenForks } = await scenario({
    settings: { maxOpenThreads: 1 },
  });
  const { threadId } = await threads.ask({ agentId: sourceId, question: "Q", askerId: "asker-1" });
  const discardGate = gate();
  client.discardGate = discardGate.promise;

  const closing = threads.close({ agentId: sourceId, threadId, askerId: "asker-1" });

  expect(threads.status({ agentId: sourceId, threadId, askerId: "asker-1" }).thread).toMatchObject({
    status: "closed",
  });
  expect(readOpenForks()).toHaveLength(1);
  await expect(
    threads.ask({ agentId: sourceId, question: "Q", askerId: "asker-2" }),
  ).rejects.toThrow("too many open copies");
  discardGate.release();
  await closing;
  expect(readOpenForks()).toEqual([]);
  client.discardGate = null;
  await expect(
    threads.ask({ agentId: sourceId, question: "Q", askerId: "asker-2" }),
  ).resolves.toBeTruthy();
});

test("daemon stop does not wait forever for a fork that will not delete", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { client, threads, sourceId } = await scenario();
  const asking = threads.ask({ agentId: sourceId, question: "Q", askerId: "asker-1" });
  await vi.advanceTimersByTimeAsync(5);
  await asking;
  const stuck = gate();
  client.discardGate = stuck.promise;

  const stopping = threads.closeAll();
  await vi.advanceTimersByTimeAsync(15_001);

  await expect(stopping).resolves.toBeUndefined();
  stuck.release();
});

test("only the asker can read or close a thread, open or closed", async () => {
  const { threads, sourceId } = await scenario();
  const { threadId } = await threads.ask({ agentId: sourceId, question: "Q", askerId: "asker-1" });
  await threads.close({ agentId: sourceId, threadId, askerId: "asker-1" });

  expect(() => threads.status({ agentId: sourceId, threadId, askerId: "asker-2" })).toThrow(
    "belongs to another asker",
  );
  await expect(threads.close({ agentId: sourceId, threadId, askerId: "asker-2" })).rejects.toThrow(
    "belongs to another asker",
  );
  await expect(
    threads.ask({ agentId: sourceId, question: "Q", askerId: "asker-2", threadId }),
  ).rejects.toThrow("belongs to another asker");
});

test("'size unknown' is said once per thread, not every round", async () => {
  const { client, threads, sourceId } = await scenario();
  client.copy.usage = undefined;

  const one = await threads.ask({ agentId: sourceId, question: "Q1", askerId: "asker-1" });
  const two = await threads.ask({ agentId: sourceId, question: "Q2", askerId: "asker-1" });

  expect(one.thread.notes).toContain("Copy size unknown.");
  expect(two.thread.notes).not.toContain("Copy size unknown.");
});

test("an archived asker's threads on other hosts are closed there, best effort", async () => {
  const { threads } = await scenario();
  const closed: string[] = [];
  threads.setRemoteCloser(async (ref) => {
    closed.push(`${ref.serverId}/${ref.agentId}/${ref.threadId}`);
    if (ref.threadId === "t3") throw new Error("host is away");
  });
  const remote = (threadId: string) => ({
    askerId: "asker-1",
    serverId: "srv_b",
    agentId: "remote-agent",
    threadId,
  });
  threads.trackRemoteThread(remote("t1"), "open");
  threads.trackRemoteThread(remote("t2"), "open");
  threads.trackRemoteThread(remote("t2"), "closed");
  threads.trackRemoteThread(remote("t3"), "open");

  await threads.handleAgentArchived("someone-else");
  expect(closed).toEqual([]);
  await expect(threads.handleAgentArchived("asker-1")).resolves.toBeUndefined();

  expect(closed.sort()).toEqual(["srv_b/remote-agent/t1", "srv_b/remote-agent/t3"]);
});

test("the tool description carries this daemon's limits", async () => {
  const { sourceCatalog } = await lockdownScenario({
    maxRounds: 3,
    replyCharLimit: 123,
    maxOpenThreads: 2,
  });

  const description = sourceCatalog.tools.get("ask_agent")!.description;

  expect(description).toContain("allows 3 rounds");
  expect(description).toContain("cut at 123 characters");
  expect(description).toContain("2 per host");
  expect(description).toContain("Omitting threadId reuses your open thread");
});
