import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import pino from "pino";
import { describe, expect, test, vi } from "vitest";

import {
  OmpAccountRoutingRefusedError,
  parseOmpCapabilityProbe,
} from "./account-routing-bridge.js";
import { OmpCliRuntime } from "./cli-runtime.js";
import type { OmpRuntimeLaunch } from "./runtime.js";
import {
  FakeOmpChild,
  type FakeOmpChildOptions,
  ROUTING_MODEL,
  ROUTING_T0,
  routingAccount,
  routingBlockedCatalog,
  routingCatalog,
  routingHost,
  routingRef,
} from "./test-utils/fake-omp.js";

type OmpChild = ChildProcessWithoutNullStreams & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  killedSignals: Array<NodeJS.Signals | number | undefined>;
};

function createOmpChild(options?: {
  supportedProtocolVersions?: number[];
  emitReady?: boolean;
  maxFrameBytes?: number;
}): OmpChild {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    killedSignals: [],
  }) as OmpChild;
  child.kill = ((signal?: NodeJS.Signals | number) => {
    child.killedSignals.push(signal);
    queueMicrotask(() => child.emit("exit", null, signal ?? null));
    return true;
  }) as ChildProcessWithoutNullStreams["kill"];
  // Real OMP writes a `ready` frame immediately after launch; the runtime waits
  // for it before negotiating the RPC protocol. Advertise v1-only by default so
  // the session stays on protocol v1 and command streams are unaffected.
  if (options?.emitReady !== false) {
    child.stdout.write(
      `${JSON.stringify({
        type: "ready",
        protocolVersion: 1,
        supportedProtocolVersions: options?.supportedProtocolVersions ?? [1],
        maxFrameBytes: options?.maxFrameBytes ?? 1024 * 1024,
        maxReassembledFrameBytes: 64 * 1024 * 1024,
      })}\n`,
    );
  }
  return child;
}

function createRuntime(
  child: OmpChild,
  launches: OmpRuntimeLaunch[] = [],
  options?: { requestTimeoutMs?: number },
): OmpCliRuntime {
  return new OmpCliRuntime({
    logger: pino({ level: "silent" }),
    command: ["omp"],
    commandsRpcName: "get_available_commands",
    requestTimeoutMs: options?.requestTimeoutMs,
    spawnProcess: (launch) => {
      launches.push(launch);
      return child;
    },
  });
}

function onOmpCommand(child: OmpChild, handler: (command: Record<string, unknown>) => void): void {
  let buffer = "";
  child.stdin.on("data", (chunk) => {
    buffer += chunk.toString();
    for (;;) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) break;
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      handler(JSON.parse(line) as Record<string, unknown>);
    }
  });
}

function replyToCommands(
  child: OmpChild,
  handler: (command: Record<string, unknown>) => unknown,
): void {
  onOmpCommand(child, (command) => {
    const result = handler(command);
    child.stdout.write(
      `${JSON.stringify({
        id: command.id,
        type: "response",
        command: command.type,
        success: true,
        data: result,
      })}\n`,
    );
  });
}

function capturePendingCommand(child: OmpChild, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    onOmpCommand(child, (command) => {
      if (command.type === type) resolve(command);
    });
  });
}

/** Kill the child the moment it receives `type`, so the request is in flight when it dies. */
function exitOnCommand(child: OmpChild, type: string): void {
  onOmpCommand(child, (command) => {
    if (command.type === type) {
      child.emit("exit", 1, null);
    }
  });
}

function withoutRequestId(command: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, ...rest } = command;
  return rest;
}

describe("OMP CLI runtime", () => {
  test("steer waits for OMP's response and surfaces rejection", async () => {
    const child = createOmpChild();
    let pending: Record<string, unknown> | null = null;
    onOmpCommand(child, (command) => {
      if (command.type === "steer") pending = command;
    });
    const launches: OmpRuntimeLaunch[] = [];
    const session = await createRuntime(child, launches).startSession({
      cwd: "/workspace/project",
      env: { HOME: "/fixture/omp-home" },
    });
    expect(session.environment).toBe(launches[0]?.env);
    expect(session.environment?.HOME).toBe("/fixture/omp-home");
    const result = session.steer("change direction");
    await new Promise((resolve) => setImmediate(resolve));
    expect(pending).toMatchObject({ type: "steer", message: "change direction" });
    child.stdout.write(
      `${JSON.stringify({ id: pending!.id, type: "response", command: "steer", success: false, error: "rejected" })}\n`,
    );
    await expect(result).rejects.toThrow("rejected");
    await session.close();
  });
  test("uses the configured RPC timeout and attributes the pending phase", async () => {
    vi.useFakeTimers();
    const child = createOmpChild();
    const session = await createRuntime(child, [], { requestTimeoutMs: 100 }).startSession({
      cwd: "/workspace/project",
    });

    try {
      const state = session.getState();
      const rejection = expect(state).rejects.toThrow(
        "OMP RPC request timed out phase=get_state elapsedMs=100 timeoutMs=100",
      );
      await vi.advanceTimersByTimeAsync(100);
      await rejection;
    } finally {
      vi.useRealTimers();
      await session.close();
    }
  });

  test("validates session state with the documented queued message count", async () => {
    const child = createOmpChild();
    replyToCommands(child, () => ({
      model: null,
      thinkingLevel: "medium",
      isStreaming: false,
      isCompacting: false,
      sessionId: "session-1",
      messageCount: 3,
      queuedMessageCount: 1,
    }));
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });

    await expect(session.getState()).resolves.toMatchObject({
      sessionId: "session-1",
      messageCount: 3,
      queuedMessageCount: 1,
    });
  });

  test("accepts session state without thinkingLevel for non-reasoning models", async () => {
    const child = createOmpChild();
    // Models like cursor-grok-4.5-high-fast encode effort in the model ID, so
    // OMP marks them reasoning: false and omits thinkingLevel from get_state.
    replyToCommands(child, () => ({
      model: null,
      isStreaming: false,
      isCompacting: false,
      sessionId: "session-1",
      messageCount: 0,
      queuedMessageCount: 0,
    }));
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });

    await expect(session.getState()).resolves.toMatchObject({ sessionId: "session-1" });
  });

  test("rejects malformed RPC results instead of trusting transport data", async () => {
    const child = createOmpChild();
    replyToCommands(child, () => ({
      thinkingLevel: "medium",
      isStreaming: "no",
      isCompacting: false,
      sessionId: "session-1",
      messageCount: 0,
      queuedMessageCount: 0,
    }));
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });

    await expect(session.getState()).rejects.toThrow();
  });

  test("emits validated known events and drops unknown frames", async () => {
    const child = createOmpChild();
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });
    const eventTypes: string[] = [];
    session.onEvent((event) => eventTypes.push(event.type));

    child.stdout.write(`${JSON.stringify({ type: "future_control", enabled: true })}\n`);
    child.stdout.write(`${JSON.stringify({ type: "notice", level: "info", message: "ready" })}\n`);

    expect(eventTypes).toEqual(["notice"]);
  });

  test("emits agent_end for a run that contains an OMP developer message", async () => {
    const child = createOmpChild();
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });
    const eventTypes: string[] = [];
    session.onEvent((event) => eventTypes.push(event.type));

    // OMP 18.5 injects a developer reminder mid-run when a tool call matches a rule.
    const reminder = {
      role: "developer",
      content: [
        { type: "text", text: '<system-reminder reason="rule_violation">…</system-reminder>' },
      ],
      attribution: "agent",
      timestamp: 2,
    };
    child.stdout.write(`${JSON.stringify({ type: "message_end", message: reminder })}\n`);
    child.stdout.write(
      `${JSON.stringify({
        type: "agent_end",
        messages: [
          { role: "user", content: [{ type: "text", text: "Write tiny.ts" }], timestamp: 1 },
          reminder,
          {
            role: "assistant",
            content: [{ type: "text", text: "Done" }],
            stopReason: "stop",
            timestamp: 3,
          },
        ],
      })}\n`,
    );

    expect(eventTypes).toEqual(["message_end", "agent_end"]);
  });

  test("emits agent_end for a run that contains every OMP message role Paseo does not render", async () => {
    const child = createOmpChild();
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });
    const eventTypes: string[] = [];
    session.onEvent((event) => eventTypes.push(event.type));

    // A prompt that @-mentions a file makes OMP add a fileMention message to the run.
    const fileMention = {
      role: "fileMention",
      files: [{ path: "notes.md", content: "# Notes\n", lineCount: 1 }],
      timestamp: 2,
    };
    child.stdout.write(`${JSON.stringify({ type: "message_end", message: fileMention })}\n`);
    child.stdout.write(
      `${JSON.stringify({
        type: "agent_end",
        messages: [
          { role: "user", content: [{ type: "text", text: "Read @notes.md" }], timestamp: 1 },
          fileMention,
          {
            role: "pythonExecution",
            code: "print(1)",
            output: "1\n",
            cancelled: false,
            truncated: false,
            timestamp: 3,
          },
          {
            role: "hookMessage",
            customType: "hook",
            content: "hook output",
            display: false,
            timestamp: 4,
          },
          { role: "branchSummary", summary: "Earlier branch", fromId: "entry-1", timestamp: 5 },
          {
            role: "compactionSummary",
            summary: "Earlier turns",
            tokensBefore: 1000,
            timestamp: 6,
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "Done" }],
            stopReason: "stop",
            timestamp: 7,
          },
        ],
      })}\n`,
    );

    expect(eventTypes).toEqual(["message_end", "agent_end"]);
  });

  test("lists commands through get_available_commands", async () => {
    const child = createOmpChild();
    const commandTypes: string[] = [];
    replyToCommands(child, (command) => {
      commandTypes.push(String(command.type));
      return {
        commands: [
          { name: "prewalk", description: "Prewalk at the next action", source: "builtin" },
        ],
      };
    });
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });

    await expect(session.getCommands()).resolves.toEqual([
      {
        name: "prewalk",
        description: "Prewalk at the next action",
        source: "builtin",
      },
    ]);
    expect(commandTypes).toEqual(["get_available_commands"]);
  });

  test("refreshes commands through refresh_commands", async () => {
    const child = createOmpChild();
    const commandTypes: string[] = [];
    replyToCommands(child, (command) => {
      commandTypes.push(String(command.type));
      return { commands: [{ name: "deploy", description: "Deploy the app", source: "skill" }] };
    });
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });

    await expect(session.refreshCommands()).resolves.toEqual([
      { name: "deploy", description: "Deploy the app", source: "skill" },
    ]);
    expect(commandTypes).toEqual(["refresh_commands"]);
  });

  test("lists known commands when OMP does not support refresh_commands", async () => {
    const child = createOmpChild();
    const commandTypes: string[] = [];
    onOmpCommand(child, (command) => {
      commandTypes.push(String(command.type));
      const response =
        command.type === "refresh_commands"
          ? { success: false, error: "Unknown command: refresh_commands" }
          : { success: true, data: { commands: [{ name: "review", source: "skill" }] } };
      child.stdout.write(
        `${JSON.stringify({ id: command.id, type: "response", command: command.type, ...response })}\n`,
      );
    });
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });

    await expect(session.refreshCommands()).resolves.toEqual([{ name: "review", source: "skill" }]);
    await expect(session.refreshCommands()).resolves.toEqual([{ name: "review", source: "skill" }]);
    expect(commandTypes).toEqual([
      "refresh_commands",
      "get_available_commands",
      "get_available_commands",
    ]);
  });

  test("surfaces refresh_commands failures other than an unknown command", async () => {
    const child = createOmpChild();
    onOmpCommand(child, (command) => {
      child.stdout.write(
        `${JSON.stringify({ id: command.id, type: "response", command: command.type, success: false, error: "discovery failed" })}\n`,
      );
    });
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });

    await expect(session.refreshCommands()).rejects.toThrow("discovery failed");
  });

  test("accepts model catalogs with null maxTokens from newer OMP binaries", async () => {
    const child = createOmpChild();
    replyToCommands(child, () => ({
      models: [
        {
          provider: "openai-codex",
          id: "gpt-5.6-sol",
          name: "gpt-5.6-sol",
          maxTokens: null,
        },
      ],
    }));
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });

    await expect(session.getAvailableModels()).resolves.toEqual([
      expect.objectContaining({
        provider: "openai-codex",
        id: "gpt-5.6-sol",
        maxTokens: null,
      }),
    ]);
  });

  test("accepts model catalogs with null contextWindow from NVIDIA", async () => {
    const child = createOmpChild();
    replyToCommands(child, () => ({
      models: [
        {
          provider: "nvidia",
          id: "minimaxai/minimax-m3",
          name: "MiniMax-M3",
          contextWindow: null,
        },
        {
          provider: "zai",
          id: "glm-5.2",
          name: "GLM-5.2",
          contextWindow: 131_072,
        },
      ],
    }));
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });

    await expect(session.getAvailableModels()).resolves.toEqual([
      expect.objectContaining({
        provider: "nvidia",
        id: "minimaxai/minimax-m3",
        contextWindow: null,
      }),
      expect.objectContaining({
        provider: "zai",
        id: "glm-5.2",
        contextWindow: 131_072,
      }),
    ]);
  });

  test("wraps OMP subagent RPC commands", async () => {
    const child = createOmpChild();
    const commands: Record<string, unknown>[] = [];
    replyToCommands(child, (command) => {
      commands.push(command);
      return undefined;
    });
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });

    await session.setSubagentSubscription("events");

    expect(commands.map(withoutRequestId)).toEqual([
      { type: "set_subagent_subscription", level: "events" },
    ]);
  });

  test("login sends the provider id, streams UI requests, and waits past the control timeout", async () => {
    vi.useFakeTimers();
    const child = createOmpChild();
    const pending = capturePendingCommand(child, "login");
    const session = await createRuntime(child, [], { requestTimeoutMs: 100 }).startSession({
      cwd: "/workspace/project",
      protocolMode: "rpc",
      noSession: true,
    });
    const events: unknown[] = [];
    session.onEvent((event) => events.push(event));
    try {
      const login = session.login("anthropic");
      const command = await pending;
      expect(withoutRequestId(command)).toEqual({ type: "login", providerId: "anthropic" });
      child.stdout.write(
        `${JSON.stringify({ type: "extension_ui_request", id: "u1", method: "open_url", url: "https://claude.example/a" })}\n`,
      );
      await vi.advanceTimersByTimeAsync(101);
      expect(events).toEqual([
        expect.objectContaining({ type: "extension_ui_request", method: "open_url" }),
      ]);
      child.stdout.write(
        `${JSON.stringify({ id: command.id, type: "response", command: "login", success: true, data: { providerId: "anthropic" } })}\n`,
      );
      await expect(login).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
      await session.close();
    }
  });

  test("compact waits beyond the control-plane timeout for a late response", async () => {
    vi.useFakeTimers();
    const child = createOmpChild();
    const pending = capturePendingCommand(child, "compact");
    const session = await createRuntime(child, [], { requestTimeoutMs: 100 }).startSession({
      cwd: "/workspace/project",
    });
    try {
      const compact = session.compact("focus on tests");
      const command = await pending;
      await vi.advanceTimersByTimeAsync(101);
      child.stdout.write(
        `${JSON.stringify({ id: command.id, type: "response", command: "compact", success: true, data: {} })}\n`,
      );
      await expect(compact).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
      await session.close();
    }
  });

  test("accepts the empty prompt acknowledgement emitted by OMP 17", async () => {
    const child = createOmpChild();
    replyToCommands(child, () => undefined);
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });

    await expect(session.prompt("hello")).resolves.toEqual({ requestId: "req_1" });
  });

  test("reports OMP 18.3's late prompt rejection as a failed prompt result", async () => {
    const child = createOmpChild();
    onOmpCommand(child, (command) => {
      if (command.type !== "prompt") return;
      const response = { id: command.id, type: "response", command: "prompt" };
      const rejection = { ...response, success: false, error: "No API key found for anthropic." };
      child.stdout.write(
        `${JSON.stringify({ ...response, success: true })}\n${JSON.stringify(rejection)}\n`,
      );
    });
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });
    const events: unknown[] = [];
    session.onEvent((event) => events.push(event));

    await expect(session.prompt("hello")).resolves.toEqual({ requestId: "req_1" });

    expect(events).toContainEqual({
      type: "prompt_result",
      id: "req_1",
      agentInvoked: false,
      status: "error",
      error: { message: "No API key found for anthropic." },
    });
  });

  test("negotiates RPC protocol v2 when OMP advertises it", async () => {
    const child = createOmpChild({ supportedProtocolVersions: [1, 2] });
    const commands: Record<string, unknown>[] = [];
    replyToCommands(child, (command) => {
      commands.push(command);
      if (command.type === "negotiate_protocol") {
        return { protocolVersion: command.protocolVersion };
      }
      if (command.type === "get_available_models") {
        return {
          models: [{ provider: "opencode-go", id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" }],
        };
      }
      return undefined;
    });
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });

    await expect(session.getAvailableModels()).resolves.toEqual([
      expect.objectContaining({ provider: "opencode-go", id: "deepseek-v4-flash" }),
    ]);
    expect(commands.map(withoutRequestId)).toContainEqual({
      type: "negotiate_protocol",
      protocolVersion: 2,
    });
  });

  test("stays on protocol v1 when OMP advertises incompatible framing limits", async () => {
    const child = createOmpChild({
      supportedProtocolVersions: [1, 2],
      maxFrameBytes: 512 * 1024,
    });
    const commands: Record<string, unknown>[] = [];
    replyToCommands(child, (command) => {
      commands.push(command);
      return { models: [] };
    });

    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });
    await session.getAvailableModels();

    expect(commands.map(withoutRequestId)).toEqual([{ type: "get_available_models" }]);
    await session.close();
  });

  test("rejects startup when OMP exits before advertising readiness", async () => {
    const child = createOmpChild({ emitReady: false });
    const startup = createRuntime(child).startSession({ cwd: "/workspace/project" });

    child.stderr.write("startup exploded");
    child.emit("exit", 7, null);

    await expect(startup).rejects.toThrow("startup exploded");
  });

  test("rejects startup when OMP exits during protocol negotiation", async () => {
    const child = createOmpChild({ supportedProtocolVersions: [1, 2] });
    child.stdin.on("data", () => {
      child.stderr.write("negotiation exploded");
      child.emit("exit", 8, null);
    });

    await expect(createRuntime(child).startSession({ cwd: "/workspace/project" })).rejects.toThrow(
      "negotiation exploded",
    );
  });

  test("reassembles chunked protocol v2 responses for large payloads", async () => {
    const child = createOmpChild({ supportedProtocolVersions: [1, 2] });
    const models = Array.from({ length: 2_000 }, (_, index) => ({
      provider: "p",
      id: `model-${index}`,
      name: `model-${index}-${"x".repeat(512)}`,
    }));
    let buffer = "";
    child.stdin.on("data", (chunk) => {
      buffer += chunk.toString();
      for (;;) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) break;
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        const command = JSON.parse(line) as Record<string, unknown>;
        if (command.type === "negotiate_protocol") {
          child.stdout.write(
            `${JSON.stringify({
              id: command.id,
              type: "response",
              command: command.type,
              success: true,
              data: { protocolVersion: 2 },
            })}\n`,
          );
          continue;
        }
        if (command.type === "get_available_models") {
          // Emit a logical response larger than the 1 MiB protocol-v1 cap as a
          // chunked (protocol v2) frame sequence, like real OMP does.
          const logical = JSON.stringify({
            id: command.id,
            type: "response",
            command: command.type,
            success: true,
            data: { models },
          });
          const bytes = Buffer.from(logical, "utf8");
          expect(bytes.byteLength).toBeGreaterThan(1024 * 1024);
          const chunkPayload = 256 * 1024;
          const count = Math.ceil(bytes.length / chunkPayload);
          for (let index = 0; index < count; index++) {
            child.stdout.write(
              `${JSON.stringify({
                type: "rpc_chunk",
                chunkId: "c1",
                index,
                count,
                byteLength: bytes.length,
                data: bytes
                  .subarray(index * chunkPayload, (index + 1) * chunkPayload)
                  .toString("base64"),
              })}\n`,
            );
          }
        }
      }
    });
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });

    const result = await session.getAvailableModels();
    expect(result).toHaveLength(2_000);
    expect(result[0]).toEqual(expect.objectContaining({ id: "model-0" }));
  });

  // A dead runtime owns no turn, so aborting it is already satisfied. Rejecting here
  // makes AgentManager treat the interrupt as unacknowledged and refuse the stop, which
  // pins the agent at `running` until the daemon restarts. See issue #3749.
  test("abort resolves once the OMP process has exited", async () => {
    const child = createOmpChild();
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });

    const environment = session.environment;
    child.emit("exit", 1, null);
    expect(session.environment).toBe(environment);
    expect(environment).toBeDefined();

    await expect(session.abort()).resolves.toBeUndefined();
  });

  test("abort resolves when the OMP process exits while the abort is in flight", async () => {
    const child = createOmpChild();
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });
    exitOnCommand(child, "abort");

    await expect(session.abort()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// Host-owned account routing over real JSONL pipes, against the real routing authority.
// ---------------------------------------------------------------------------------------------

const OTHER_NAMESPACE = "22222222-2222-4222-8222-222222222222";

async function startManaged(
  host: ReturnType<typeof routingHost>,
  childOptions: FakeOmpChildOptions = {},
  routing: { agentId?: string } = { agentId: "agent-1" },
  probe: { complete: boolean; version: number } = { complete: true, version: 1 },
) {
  const child = new FakeOmpChild(childOptions);
  const launches: OmpRuntimeLaunch[] = [];
  const probes: OmpRuntimeLaunch[] = [];
  const runtime = new OmpCliRuntime({
    logger: pino({ level: "silent" }),
    command: ["omp"],
    spawnProcess: (launch) => {
      launches.push(launch);
      return child.process;
    },
    probeCapabilities: async (launch) => {
      probes.push(launch);
      return probe;
    },
  });
  const session = await runtime.startSession({
    cwd: "/workspace/project",
    routing: { authority: host.authority, ...routing },
  });
  return { child, launches, probes, session };
}

function admitRequest(
  host: ReturnType<typeof routingHost>,
  runtimeInstanceId: string,
  overrides: Record<string, unknown> = {},
) {
  const n = String(overrides.n ?? "1");
  return {
    type: "account.routing.admit.request",
    id: `ar-${runtimeInstanceId}-${n}`,
    hostEpoch: host.authority.hostEpoch,
    runtimeInstanceId,
    operationId: `op-${n}`,
    attemptId: `attempt-${n}`,
    sessionId: "native-session-1",
    purpose: "main",
    provider: "anthropic",
    modelId: ROUTING_MODEL,
    requestGeneration: 1,
    catalog: routingCatalog(runtimeInstanceId, [routingAccount(1), routingAccount(2)], {
      catalogRevision: 1,
      observedAt: host.clock.time,
    }),
    ...overrides,
  };
}

async function admission(
  child: FakeOmpChild,
  host: ReturnType<typeof routingHost>,
  runtimeInstanceId: string,
  overrides: Record<string, unknown> = {},
) {
  const request = admitRequest(host, runtimeInstanceId, overrides);
  child.emit(request);
  const response = await child.waitForFrame(
    "account.routing.admit.response",
    (frame) => frame.id === request.id,
  );
  return { request, decision: response.decision as Record<string, unknown> };
}

function runtimeInstanceOf(child: FakeOmpChild): string {
  return String(child.framesOfType("account.routing.configure")[0]?.runtimeInstanceId);
}

function activeRequests(host: ReturnType<typeof routingHost>) {
  return host.authority.snapshot().activeRequests;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("OMP host account routing", () => {
  test("a managed launch is marked, probed first, configured, and attached to the authority", async () => {
    const host = routingHost();
    const { child, launches, probes } = await startManaged(host);
    const configure = child.framesOfType("account.routing.configure")[0];

    expect(probes).toHaveLength(1);
    expect(launches[0]?.env?.OMP_HOST_ACCOUNT_ROUTING).toBe("1");
    expect(configure).toMatchObject({
      version: 1,
      hostEpoch: host.authority.hostEpoch,
      scope: "host-owned",
      provider: "anthropic",
      includedOnly: true,
    });
    expect(typeof configure.runtimeInstanceId).toBe("string");
    expect(host.authority.snapshot().capability.status).toBe("supported");
    expect(host.authority.snapshot().accounts.map((a) => a.ref.nativeRowId)).toEqual([1, 2]);
  });

  test("accepts OMP's own billing shape: an absent reason and native reason names", async () => {
    const host = routingHost();
    const nativeCatalog = (runtimeInstanceId: string) => {
      const catalog = JSON.parse(
        JSON.stringify(
          routingCatalog(runtimeInstanceId, [
            routingAccount(1),
            routingAccount(2),
            routingAccount(3),
          ]),
        ),
      );
      // OMP omits `reason` when there is none and uses its own reason vocabulary.
      delete catalog.accounts[0].billing.reason;
      catalog.accounts[1].billing = {
        state: "unknown",
        observedAt: null,
        validUntil: null,
        source: null,
        sourceRevision: null,
        reason: "no_evidence",
      };
      catalog.accounts[2].billing = { ...catalog.accounts[1].billing, reason: "conflict" };
      return catalog;
    };
    await startManaged(host, {
      configure: (command) => ({ catalogs: [nativeCatalog(String(command.runtimeInstanceId))] }),
    });

    const snapshot = host.authority.snapshot();
    expect(snapshot.capability.status).toBe("supported");
    expect(
      snapshot.accounts.map((a) => [a.ref.nativeRowId, a.billing.state, a.billing.reason]),
    ).toEqual([
      [1, "disabled", null],
      [2, "unknown", null],
      [3, "unknown", "conflicting"],
    ]);
  });

  test("frames the child sends in the same burst as its configure reply are queued, not lost", async () => {
    const host = routingHost();
    let runtimeInstanceId = "";
    const { child } = await startManaged(host, {
      afterConfigure: (id) => {
        runtimeInstanceId = id;
        return [admitRequest(host, id)];
      },
    });

    const response = await child.waitForFrame("account.routing.admit.response");
    expect(response).toMatchObject({
      id: `ar-${runtimeInstanceId}-1`,
      hostEpoch: host.authority.hostEpoch,
      runtimeInstanceId,
      decision: { kind: "admit", accountRef: routingRef(1) },
    });
    // The wire decision is exactly native's shape: no host-only fields leak.
    expect(Object.keys(response.decision as object).sort()).toEqual([
      "accountRef",
      "admissionId",
      "kind",
      "policyRevision",
      "selectionGeneration",
    ]);
  });

  test("a child that refuses configure fails the launch closed and registers nothing", async () => {
    const host = routingHost();
    const child = new FakeOmpChild({ configure: () => ({ error: "unsupported_runtime" }) });
    const runtime = new OmpCliRuntime({
      logger: pino({ level: "silent" }),
      command: ["omp"],
      spawnProcess: () => child.process,
      probeCapabilities: async () => ({ complete: true, version: 1 }),
    });

    await expect(
      runtime.startSession({
        cwd: "/workspace/project",
        routing: { authority: host.authority, agentId: "agent-1" },
      }),
    ).rejects.toMatchObject({ code: "unsupported_runtime" });
    expect(host.authority.snapshot().capability.status).toBe("unknown");
    expect(child.framesOfType("account.routing.admit.response")).toEqual([]);
  });

  test.each([
    ["incomplete coverage", { completeCoverage: false }],
    ["forbidden dispatch", { modelDispatch: "forbidden" }],
  ])("configure reporting %s is refused", async (_name, reply) => {
    const host = routingHost();
    const child = new FakeOmpChild({ configure: () => reply });
    const runtime = new OmpCliRuntime({
      logger: pino({ level: "silent" }),
      command: ["omp"],
      spawnProcess: () => child.process,
      probeCapabilities: async () => ({ complete: true, version: 1 }),
    });

    const start = runtime.startSession({
      cwd: "/workspace/project",
      routing: { authority: host.authority, agentId: "agent-1" },
    });
    await expect(start).rejects.toBeInstanceOf(OmpAccountRoutingRefusedError);
    expect(host.authority.snapshot().capability.status).toBe("unknown");
  });

  test("a binary whose probe is incomplete launches unmarked and reports the capability unsupported", async () => {
    const host = routingHost();
    const { child, launches, session } = await startManaged(
      host,
      {},
      { agentId: "agent-1" },
      { complete: false, version: 1 },
    );

    expect(launches[0]?.env?.OMP_HOST_ACCOUNT_ROUTING).toBeUndefined();
    expect(child.framesOfType("account.routing.configure")).toEqual([]);
    expect(host.authority.snapshot().capability).toMatchObject({ status: "unsupported" });

    await session.close();
    expect(host.authority.snapshot().capability.status).toBe("unknown");
  });

  test.each([
    ["old binary, empty output", ""],
    ["not JSON", "usage: omp [options]"],
    ["missing coverage fields", JSON.stringify({ version: 1, provider: "anthropic" })],
    [
      "completeCoverage false",
      JSON.stringify({
        version: 1,
        provider: "anthropic",
        managedAccountRouting: {
          modelDispatch: "allowed",
          completeCoverage: false,
          purposes: ["model-dispatch", "metadata", "usage-refresh"],
          sourceIdentity: "v1",
          exactUsageRefresh: "v1",
        },
      }),
    ],
    [
      "metadata mode document",
      JSON.stringify({
        version: 1,
        provider: "anthropic",
        managedAccountRouting: {
          modelDispatch: "forbidden",
          completeCoverage: false,
          purposes: ["model-dispatch", "metadata", "usage-refresh"],
          sourceIdentity: "v1",
          exactUsageRefresh: "v1",
        },
      }),
    ],
  ])("capability probe treats %s as incomplete", (_name, stdout) => {
    expect(parseOmpCapabilityProbe(stdout).complete).toBe(false);
  });

  test("capability probe accepts the native version-1 document", () => {
    const stdout = `${JSON.stringify({
      version: 1,
      provider: "anthropic",
      managedAccountRouting: {
        modelDispatch: "allowed",
        completeCoverage: true,
        purposes: ["model-dispatch", "metadata", "usage-refresh"],
        sourceIdentity: "v1",
        exactUsageRefresh: "v1",
      },
      build: { version: null },
    })}\n`;
    expect(parseOmpCapabilityProbe(stdout)).toEqual({ complete: true, version: 1 });
  });

  test("an agentless helper is marked metadata-only, never probed or configured", async () => {
    const host = routingHost();
    const { child, launches, probes } = await startManaged(host, {}, {});

    expect(launches[0]?.env?.OMP_HOST_ACCOUNT_ROUTING).toBe("metadata");
    expect(probes).toEqual([]);
    expect(child.framesOfType("account.routing.configure")).toEqual([]);
    expect(host.authority.snapshot().capability.status).toBe("unknown");
  });

  test("an independent launch carries no marker, no probe and no routing frames", async () => {
    const child = new FakeOmpChild();
    const launches: OmpRuntimeLaunch[] = [];
    const probe = vi.fn();
    const runtime = new OmpCliRuntime({
      logger: pino({ level: "silent" }),
      command: ["omp"],
      spawnProcess: (launch) => {
        launches.push(launch);
        return child.process;
      },
      probeCapabilities: probe,
    });

    const session = await runtime.startSession({ cwd: "/workspace/project" });
    await session.getState();

    expect(launches[0]?.env?.OMP_HOST_ACCOUNT_ROUTING).toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
    expect(child.received.map((frame) => frame.type)).toEqual(["get_state"]);
  });

  test("a manual selection mid-request moves the next call, not the one in flight, and sends no command", async () => {
    const host = routingHost();
    const { child } = await startManaged(host);
    const runtimeInstanceId = runtimeInstanceOf(child);

    const first = await admission(child, host, runtimeInstanceId, { n: 1 });
    expect(first.decision).toMatchObject({ kind: "admit", accountRef: routingRef(1) });
    child.emit({
      type: "account.routing.started",
      hostEpoch: host.authority.hostEpoch,
      runtimeInstanceId,
      admissionId: first.decision.admissionId,
      operationId: "op-1",
      attemptId: "attempt-1",
      sessionId: "native-session-1",
      modelId: ROUTING_MODEL,
      accountRef: routingRef(1),
      selectionGeneration: first.decision.selectionGeneration,
      startedAt: ROUTING_T0 + 5,
    });
    await flush();
    const framesBefore = child.received.length;

    const committed = await host.authority.mutate({
      expectedPolicyRevision: host.authority.snapshot().policy.policyRevision,
      command: { kind: "select", account: routingRef(2) },
    });
    expect(committed.error).toBeNull();
    await flush();

    // The request in flight is still attributed to the account that serves it.
    expect(activeRequests(host)).toEqual([
      expect.objectContaining({
        admissionId: first.decision.admissionId,
        accountRef: routingRef(1),
        phase: "serving",
      }),
    ]);
    // Selecting moved policy only: nothing was written to the child, no pin, no restart.
    expect(child.received.length).toBe(framesBefore);

    const second = await admission(child, host, runtimeInstanceId, { n: 2, requestGeneration: 2 });
    expect(second.decision).toMatchObject({ kind: "admit", accountRef: routingRef(2) });

    // The stale outcome for A settles A's binding and does not mutate the selection.
    child.emit({
      type: "account.routing.outcome",
      hostEpoch: host.authority.hostEpoch,
      runtimeInstanceId,
      admissionId: first.decision.admissionId,
      operationId: "op-1",
      attemptId: "attempt-1",
      sessionId: "native-session-1",
      modelId: ROUTING_MODEL,
      accountRef: routingRef(1),
      selectionGeneration: first.decision.selectionGeneration,
      startedAt: ROUTING_T0 + 5,
      finishedAt: ROUTING_T0 + 50,
      code: "success",
      dispatch: "dispatched",
      replaySafe: false,
      refusalReason: null,
      retryAfterMs: null,
      quotaBlocks: [],
      windows: [],
    });
    await flush();
    const state = host.authority.snapshot();
    expect(state.policy.current).toEqual(routingRef(2));
    expect(state.activeRequests.map((r) => r.accountRef)).toEqual([routingRef(2)]);
    expect(
      child.received
        .map((frame) => String(frame.type))
        .filter((type) => type.startsWith("account.routing.") === false),
    ).toEqual([]);
  });

  test("a model-scoped quota block holds that model only", async () => {
    const host = routingHost();
    const { child } = await startManaged(host);
    const runtimeInstanceId = runtimeInstanceOf(child);
    for (const command of [
      { kind: "select", account: routingRef(1) },
      { kind: "set_auto", enabled: false },
    ] as const) {
      const result = await host.authority.mutate({
        expectedPolicyRevision: host.authority.snapshot().policy.policyRevision,
        command,
      });
      expect(result.error).toBeNull();
    }

    const held = await admission(child, host, runtimeInstanceId, { n: 1 });
    child.emit({
      type: "account.routing.outcome",
      hostEpoch: host.authority.hostEpoch,
      runtimeInstanceId,
      admissionId: held.decision.admissionId,
      operationId: "op-1",
      attemptId: "attempt-1",
      sessionId: "native-session-1",
      modelId: ROUTING_MODEL,
      accountRef: routingRef(1),
      selectionGeneration: held.decision.selectionGeneration,
      startedAt: ROUTING_T0 + 1,
      finishedAt: ROUTING_T0 + 2,
      code: "quota_exhausted",
      dispatch: "dispatched",
      replaySafe: false,
      refusalReason: null,
      retryAfterMs: null,
      quotaBlocks: [
        {
          limitId: "weekly-sonnet",
          scope: { kind: "model", modelId: ROUTING_MODEL },
          resetAt: ROUTING_T0 + 3_600_000,
          observedAt: ROUTING_T0 + 2,
          source: "provider-rejection",
          confirmed: true,
        },
      ],
      windows: [],
    });
    await flush();

    const sameModel = await admission(child, host, runtimeInstanceId, { n: 2 });
    const otherModel = await admission(child, host, runtimeInstanceId, {
      n: 3,
      modelId: "claude-haiku-4-5",
    });
    expect(sameModel.decision).toMatchObject({ kind: "wait", reason: "auto_disabled" });
    expect(otherModel.decision).toMatchObject({ kind: "admit", accountRef: routingRef(1) });
  });

  test("a quota wait wakes with a resume hint, then the call re-admits; a cancelled wait never wakes", async () => {
    const host = routingHost();
    const resetAt = ROUTING_T0 + 60_000;
    const blockedCatalog = (runtimeInstanceId: string, revision: number, blocked: boolean) =>
      routingBlockedCatalog(runtimeInstanceId, revision, blocked ? resetAt : null, host.clock.time);
    const { child } = await startManaged(host, {
      catalogs: (id) => [blockedCatalog(id, 1, true)],
    });
    const runtimeInstanceId = runtimeInstanceOf(child);

    const waiting = await admission(child, host, runtimeInstanceId, {
      n: 1,
      catalog: blockedCatalog(runtimeInstanceId, 1, true),
    });
    expect(waiting.decision).toMatchObject({
      kind: "wait",
      reason: "all_unavailable",
      reconsiderAt: resetAt,
    });
    const waitId = String(waiting.decision.waitId);
    child.emit({
      type: "account.routing.paused",
      hostEpoch: host.authority.hostEpoch,
      runtimeInstanceId,
      waitId,
      operationId: "op-1",
      attemptId: "attempt-1",
      sessionId: "native-session-1",
      modelId: ROUTING_MODEL,
      reason: "all_unavailable",
    });
    await flush();
    expect(host.authority.snapshot().pausedRequests.map((w) => w.waitId)).toEqual([waitId]);
    expect(child.framesOfType("account.routing.resume")).toEqual([]);

    // A second call waits too, then native cancels it: only the live wait may wake.
    const doomed = await admission(child, host, runtimeInstanceId, {
      n: 2,
      catalog: blockedCatalog(runtimeInstanceId, 1, true),
    });
    child.emit({
      type: "account.routing.cancel",
      id: `ar-${runtimeInstanceId}-2`,
      hostEpoch: host.authority.hostEpoch,
      runtimeInstanceId,
      waitId: doomed.decision.waitId,
      operationId: "op-2",
      attemptId: "attempt-2",
      sessionId: "native-session-1",
    });
    await flush();

    host.clock.advance(60_000);
    await flush();
    const resumes = child.framesOfType("account.routing.resume");
    expect(resumes).toEqual([
      {
        type: "account.routing.resume",
        hostEpoch: host.authority.hostEpoch,
        runtimeInstanceId,
        waitId,
      },
    ]);

    // Resume is a hint, not a grant: the child asks again, retiring the wait.
    const again = await admission(child, host, runtimeInstanceId, {
      n: 3,
      operationId: "op-1",
      attemptId: "attempt-3",
      previousWaitId: waitId,
      catalog: blockedCatalog(runtimeInstanceId, 2, false),
    });
    expect(again.decision).toMatchObject({ kind: "admit" });
    expect(host.authority.snapshot().pausedRequests.map((w) => w.waitId)).not.toContain(
      doomed.decision.waitId,
    );
  });

  test("cancelling an admission still being decided sends no response and leaves nothing bound", async () => {
    const host = routingHost();
    const gate = Promise.withResolvers<void>();
    const { child } = await startManaged(host, {
      rank: async () => {
        await gate.promise;
        return { error: "metadata_pending" };
      },
    });
    const runtimeInstanceId = runtimeInstanceOf(child);

    const request = admitRequest(host, runtimeInstanceId);
    child.emit(request);
    await child.waitForFrame("account.routing.rank");
    child.emit({
      type: "account.routing.cancel",
      id: request.id,
      hostEpoch: host.authority.hostEpoch,
      runtimeInstanceId,
      operationId: request.operationId,
      attemptId: request.attemptId,
      sessionId: request.sessionId,
    });
    await flush();
    gate.resolve();
    await flush();

    expect(child.framesOfType("account.routing.admit.response")).toEqual([]);
    expect(activeRequests(host)).toEqual([]);
  });

  test("a catalog from a namespace the child did not declare is refused as an inaccessible source", async () => {
    const host = routingHost();
    const { child } = await startManaged(host);
    const runtimeInstanceId = runtimeInstanceOf(child);

    const { decision } = await admission(child, host, runtimeInstanceId, {
      catalog: routingCatalog(runtimeInstanceId, [routingAccount(1, {}, OTHER_NAMESPACE)], {
        storeNamespace: OTHER_NAMESPACE,
      }),
    });

    expect(decision).toEqual({ kind: "refuse", reason: "source_inaccessible" });
    expect(activeRequests(host)).toEqual([]);
  });

  test("a selection in a namespace this runtime cannot open refuses instead of substituting", async () => {
    const host = routingHost();
    const owner = await startManaged(host, {}, { agentId: "agent-1" });
    const selected = await host.authority.mutate({
      expectedPolicyRevision: host.authority.snapshot().policy.policyRevision,
      command: { kind: "select", account: routingRef(1) },
    });
    expect(selected.error).toBeNull();
    const disjoint = await startManaged(
      host,
      {
        configure: () => ({ accessibleNamespaces: [OTHER_NAMESPACE] }),
        catalogs: (id) => [
          routingCatalog(id, [routingAccount(1, {}, OTHER_NAMESPACE)], {
            storeNamespace: OTHER_NAMESPACE,
          }),
        ],
      },
      { agentId: "agent-2" },
    );
    const runtimeInstanceId = runtimeInstanceOf(disjoint.child);

    const { decision } = await admission(disjoint.child, host, runtimeInstanceId, {
      catalog: routingCatalog(runtimeInstanceId, [routingAccount(1, {}, OTHER_NAMESPACE)], {
        storeNamespace: OTHER_NAMESPACE,
      }),
    });

    // The lookalike row 1 in the other store is never substituted, and the choice does not move.
    expect(decision).toEqual({ kind: "refuse", reason: "source_inaccessible" });
    expect(host.authority.snapshot().policy.current).toEqual(routingRef(1));
    expect(host.authority.snapshot().capability.status).toBe("supported");
    expect(owner.child.framesOfType("account.routing.admit.response")).toEqual([]);
  });

  test("an outcome naming another account does not settle the admission", async () => {
    const host = routingHost();
    const { child } = await startManaged(host);
    const runtimeInstanceId = runtimeInstanceOf(child);
    const granted = await admission(child, host, runtimeInstanceId);

    child.emit({
      type: "account.routing.outcome",
      hostEpoch: host.authority.hostEpoch,
      runtimeInstanceId,
      admissionId: granted.decision.admissionId,
      operationId: "op-1",
      attemptId: "attempt-1",
      sessionId: "native-session-1",
      modelId: ROUTING_MODEL,
      accountRef: routingRef(2),
      selectionGeneration: granted.decision.selectionGeneration,
      startedAt: null,
      finishedAt: ROUTING_T0 + 1,
      code: "cancelled",
      dispatch: "not_dispatched",
      replaySafe: true,
      refusalReason: "cancelled",
      retryAfterMs: null,
      quotaBlocks: [],
      windows: [],
    });
    await flush();

    expect(activeRequests(host).map((r) => r.admissionId)).toEqual([granted.decision.admissionId]);
  });

  test("frames for another epoch or instance are ignored and answered with nothing", async () => {
    const host = routingHost();
    const { child } = await startManaged(host);
    const runtimeInstanceId = runtimeInstanceOf(child);

    child.emit(admitRequest(host, runtimeInstanceId, { hostEpoch: "stale-epoch", n: 1 }));
    child.emit(admitRequest(host, "another-instance", { n: 2 }));
    await flush();

    expect(child.framesOfType("account.routing.admit.response")).toEqual([]);
    expect(activeRequests(host)).toEqual([]);
  });

  test("a malformed admit request is refused by name so the model call cannot hang", async () => {
    const host = routingHost();
    const { child } = await startManaged(host);
    const runtimeInstanceId = runtimeInstanceOf(child);

    child.emit({ type: "account.routing.admit.request", id: "ar-bad", hostEpoch: "x" });
    const response = await child.waitForFrame("account.routing.admit.response");

    expect(response).toMatchObject({
      id: "ar-bad",
      decision: { kind: "refuse", reason: "host_unavailable" },
    });
    expect(runtimeInstanceId).not.toBe("");
  });

  test("closing the session detaches the runtime, clears transient work and keeps policy", async () => {
    const host = routingHost();
    const { child, session } = await startManaged(host);
    const runtimeInstanceId = runtimeInstanceOf(child);
    await admission(child, host, runtimeInstanceId);
    const policy = host.authority.snapshot().policy;

    await session.close();

    const state = host.authority.snapshot();
    expect(state.capability.status).toBe("unknown");
    expect(state.activeRequests).toEqual([]);
    expect(state.policy).toEqual(policy);
  });

  test("the child exiting detaches the runtime", async () => {
    const host = routingHost();
    const { child } = await startManaged(host);
    await admission(child, host, runtimeInstanceOf(child));

    child.exit(1);
    await flush();

    expect(activeRequests(host)).toEqual([]);
    expect(host.authority.snapshot().capability.status).toBe("unknown");
  });
});
