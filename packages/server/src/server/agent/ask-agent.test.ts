import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { askAgent } from "./ask-agent.js";
import type {
  AgentClient,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
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

/** One provider session. Each turn answers with the session id it ran in. */
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
    private readonly behavior: CopyBehavior,
    private readonly onTurnStarted?: () => void,
  ) {}

  async run(): Promise<AgentRunResult> {
    throw new Error("run is not used by the manager");
  }

  async startTurn(prompt: AgentPromptInput): Promise<{ turnId: string }> {
    this.prompts.push(String(prompt));
    const turnId = `turn-${++this.turn}`;
    // Deferred like a provider: the manager has the turn id before the turn's events arrive.
    setTimeout(() => {
      this.emit({ type: "turn_started", provider: this.provider, turnId });
      this.onTurnStarted?.();
      if (this.behavior === "answer") this.finish(turnId);
      if (this.behavior === "asks-permission") {
        this.emit({
          type: "permission_requested",
          provider: this.provider,
          turnId,
          request: { id: "perm-1", provider: this.provider, name: "Bash", kind: "tool" },
        });
      }
    }, 0);
    return { turnId };
  }

  private finish(turnId: string): void {
    this.emit({
      type: "timeline",
      provider: this.provider,
      turnId,
      item: { type: "assistant_message", text: `answer from ${this.id}` },
    });
    this.emit({ type: "turn_completed", provider: this.provider, turnId });
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
  readonly discarded: string[] = [];
  copyBehavior: CopyBehavior = "answer";
  onCopyTurnStarted: (() => void) | undefined;
  private forks = 0;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async fetchCatalog() {
    return { models: [], modes: [] };
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    const session = new ScriptedSession("source-session", config, "answer");
    this.sessions.set(session.id, session);
    return session;
  }

  async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
  ): Promise<AgentSession> {
    const session = new ScriptedSession(
      handle.sessionId,
      { ...(handle.metadata as Partial<AgentSessionConfig>), ...overrides },
      this.copyBehavior,
      this.onCopyTurnStarted,
    );
    this.sessions.set(session.id, session);
    return session;
  }

  async forkNativeSession(handle: AgentPersistenceHandle): Promise<ForkedNativeSession> {
    const sessionId = `${handle.sessionId}-copy-${++this.forks}`;
    return {
      handle: { ...handle, sessionId },
      readOnlyModeId: "read-only",
      discard: async () => {
        this.discarded.push(sessionId);
      },
    };
  }
}

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

async function scenario() {
  const workdir = mkdtempSync(join(tmpdir(), "ask-agent-"));
  const client = new ForkingClient();
  const manager = new AgentManager({ clients: { codex: client }, logger: createTestLogger() });
  const source = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
    workspaceId: undefined,
  });
  await manager.runAgent(source.id, "remember the plan");
  cleanup = async () => {
    await manager.closeAgent(source.id).catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  };
  const sourceSession = client.sessions.get("source-session")!;
  return { client, manager, sourceId: source.id, sourceSession };
}

test("a hidden read-only copy answers and the asked agent never sees the question", async () => {
  const { client, manager, sourceId, sourceSession } = await scenario();

  const { answer } = await askAgent(manager, createTestLogger(), {
    agentId: sourceId,
    question: "What is the plan?",
    askedBy: "planner",
  });

  expect(answer).toBe("answer from source-session-copy-1");
  expect(sourceSession.prompts).toEqual(["remember the plan"]);
  const copy = client.sessions.get("source-session-copy-1")!;
  expect(copy.config).toMatchObject({ internal: true, modeId: "read-only" });
  expect(copy.prompts[0]).toContain("What is the plan?");
  expect(copy.prompts[0]).toContain('"planner"');
  expect(copy.closed).toBe(true);
  expect(client.discarded).toEqual(["source-session-copy-1"]);
  expect(manager.listAgents().map((agent) => agent.id)).toEqual([sourceId]);
});

test("the copy's approval requests are denied instead of waiting for a human", async () => {
  const { client, manager, sourceId } = await scenario();
  client.copyBehavior = "asks-permission";

  const { answer } = await askAgent(manager, createTestLogger(), {
    agentId: sourceId,
    question: "Run the tests?",
  });

  expect(answer).toBe("answer from source-session-copy-1");
  expect(client.sessions.get("source-session-copy-1")!.permissionResponses).toEqual([
    expect.objectContaining({ behavior: "deny" }),
  ]);
});

test("an abandoned question cancels the copy's turn and deletes the copy", async () => {
  const { client, manager, sourceId } = await scenario();
  client.copyBehavior = "hangs";
  const caller = new AbortController();
  client.onCopyTurnStarted = () => caller.abort(new Error("caller went away"));

  await expect(
    askAgent(manager, createTestLogger(), {
      agentId: sourceId,
      question: "Status?",
      signal: caller.signal,
    }),
  ).rejects.toThrow("caller went away");

  expect(client.sessions.get("source-session-copy-1")!.closed).toBe(true);
  expect(client.discarded).toEqual(["source-session-copy-1"]);
});
test("a provider without session forking is refused before anything runs", async () => {
  const { client, manager, sourceId, sourceSession } = await scenario();
  Object.defineProperty(client, "forkNativeSession", { value: undefined });

  await expect(
    askAgent(manager, createTestLogger(), { agentId: sourceId, question: "Status?" }),
  ).rejects.toThrow("cannot fork");
  expect(sourceSession.prompts).toEqual(["remember the plan"]);
});
