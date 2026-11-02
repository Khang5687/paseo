import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import { forkAgent } from "./fork-agent.js";
import { createPaseoToolCatalog } from "./tools/paseo-tools.js";
import type { ToolHosts } from "./host-operations/index.js";
import type {
  AgentClient,
  AgentForkSessionInput,
  AgentForkSessionResult,
} from "./agent-sdk-types.js";

const logger = createTestLogger();

interface Harness {
  manager: AgentManager;
  storage: AgentStorage;
  forkCalls: AgentForkSessionInput[];
  prompts: string[];
  sourceId: string;
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "fork-agent-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function createHarness(options: {
  nativeFork: boolean;
  forkUsage?: Pick<AgentForkSessionResult, "contextWindowUsedTokens" | "contextWindowMaxTokens">;
}): Promise<Harness> {
  const forkCalls: AgentForkSessionInput[] = [];
  const prompts: string[] = [];
  const base = createTestAgentClient("omp", {
    onStartTurn: (prompt) =>
      prompts.push(typeof prompt === "string" ? prompt : JSON.stringify(prompt)),
  });
  const client: AgentClient = {
    provider: base.provider,
    capabilities: { ...base.capabilities, supportsNativeFork: options.nativeFork },
    createSession: (...args) => base.createSession(...args),
    resumeSession: (...args) => base.resumeSession(...args),
    fetchCatalog: (...args) => base.fetchCatalog(...args),
    isAvailable: () => base.isAvailable(),
    ...(options.nativeFork
      ? {
          forkSession: async (handle, input) => {
            forkCalls.push(input);
            return {
              persistence: {
                provider: "omp",
                sessionId: "forked-session",
                metadata: handle.metadata,
              },
              ...options.forkUsage,
            };
          },
        }
      : {}),
  };
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const manager = new AgentManager({ clients: { omp: client }, registry: storage, logger });
  const source = await manager.createAgent({ provider: "omp", cwd: root }, undefined, {
    workspaceId: "workspace-1",
    labels: {
      keep: "yes",
      "paseo.open-agent-tab.client": "true",
      "paseo.parent-agent-id": "some-parent",
    },
  });
  return { manager, storage, forkCalls, prompts, sourceId: source.id };
}

async function seedConversation(harness: Harness, withCompaction: boolean): Promise<void> {
  const { manager, sourceId } = harness;
  await manager.appendTimelineItem(sourceId, {
    type: "user_message",
    text: "ancient question about the flux capacitor",
    messageId: "entry-u0",
  });
  await manager.appendTimelineItem(sourceId, {
    type: "assistant_message",
    text: "ancient answer about the flux capacitor",
    messageId: "entry-a0",
  });
  if (withCompaction) {
    await manager.appendTimelineItem(sourceId, { type: "compaction", status: "completed" });
  }
  await manager.appendTimelineItem(sourceId, {
    type: "user_message",
    text: "first question",
    messageId: "entry-u1",
  });
  await manager.appendTimelineItem(sourceId, {
    type: "assistant_message",
    text: "first answer",
    messageId: "msg-a1",
  });
  await manager.appendTimelineItem(sourceId, {
    type: "user_message",
    text: "second question",
    messageId: "entry-u2",
  });
  await manager.appendTimelineItem(sourceId, {
    type: "assistant_message",
    text: "second answer",
    messageId: "msg-a2",
  });
}

function forkInput(harness: Harness, boundaryMessageId?: string) {
  return {
    agentManager: harness.manager,
    agentStorage: harness.storage,
    logger,
    agentId: harness.sourceId,
    boundaryMessageId,
    agentTitle: "Source chat",
  };
}

describe("forkAgent", () => {
  test("a native fork cuts the provider session before the first message after the boundary", async () => {
    const harness = await createHarness({ nativeFork: true });
    await seedConversation(harness, false);

    const result = await forkAgent(forkInput(harness, "msg-a1"));

    expect(result.method).toBe("native");
    expect(harness.forkCalls).toEqual([{ cutBeforeMessageId: "entry-u2", cwd: root }]);
    expect(result.agent.id).not.toBe(harness.sourceId);
    expect(result.agent.persistence?.sessionId).toBe("forked-session");
    expect(result.agent.config.title).toBe("Source chat (fork)");
    expect(result.agent.labels).toEqual({ keep: "yes" });
    expect(harness.prompts).toEqual([]);
  });

  test("a boundary on the last response keeps the whole provider session", async () => {
    const harness = await createHarness({ nativeFork: true });
    await seedConversation(harness, false);

    await forkAgent(forkInput(harness, "msg-a2"));
    await forkAgent(forkInput(harness));

    expect(harness.forkCalls.map((call) => call.cutBeforeMessageId)).toEqual([null, null]);
  });

  test("a fork that fits the model window adds no summary even when the source compacted", async () => {
    const harness = await createHarness({
      nativeFork: true,
      forkUsage: { contextWindowUsedTokens: 80_000, contextWindowMaxTokens: 100_000 },
    });
    await seedConversation(harness, true);

    const result = await forkAgent(forkInput(harness, "msg-a2"));

    expect(result.method).toBe("native");
    expect(harness.prompts).toEqual([]);
  });

  test("a fork that exceeds the model window adds one summary of the compacted history", async () => {
    const harness = await createHarness({
      nativeFork: true,
      forkUsage: { contextWindowUsedTokens: 209_000, contextWindowMaxTokens: 100_000 },
    });
    await seedConversation(harness, true);

    const result = await forkAgent(forkInput(harness, "msg-a1"));
    await vi.waitFor(() => expect(harness.prompts).toHaveLength(1));

    expect(result.method).toBe("native_with_summary");
    expect(harness.forkCalls[0]?.cutBeforeMessageId).toBe("entry-u2");
    expect(harness.prompts).toHaveLength(1);
    const [prompt] = harness.prompts;
    expect(prompt).toContain("ancient question about the flux capacitor");
    expect(prompt).toContain("ancient answer about the flux capacitor");
    expect(prompt).not.toContain("first question");
    expect(prompt).not.toContain("second question");
  });

  test("an oversized fork with nothing compacted away adds no summary", async () => {
    const harness = await createHarness({
      nativeFork: true,
      forkUsage: { contextWindowUsedTokens: 209_000, contextWindowMaxTokens: 100_000 },
    });
    await seedConversation(harness, false);

    const result = await forkAgent(forkInput(harness, "msg-a2"));

    expect(result.method).toBe("native");
    expect(harness.prompts).toEqual([]);
  });

  test("a provider without native fork starts a fresh agent seeded with the history up to the boundary", async () => {
    const harness = await createHarness({ nativeFork: false });
    await seedConversation(harness, false);

    const result = await forkAgent(forkInput(harness, "msg-a1"));
    await vi.waitFor(() => expect(harness.prompts).toHaveLength(1));

    expect(result.method).toBe("summary");
    expect(result.agent.id).not.toBe(harness.sourceId);
    expect(result.agent.persistence?.sessionId).not.toBe("forked-session");
    expect(harness.prompts).toHaveLength(1);
    const [prompt] = harness.prompts;
    expect(prompt).toContain("first question");
    expect(prompt).toContain("first answer");
    expect(prompt).not.toContain("second question");
    expect(prompt).not.toContain("second answer");
  });
});

describe("fork_agent tool", () => {
  function catalogFor(
    harness: Harness,
    extra: { callerAgentId?: string; serverId?: string; hosts?: () => ToolHosts } = {},
  ) {
    return createPaseoToolCatalog({
      agentManager: harness.manager,
      agentStorage: harness.storage,
      // Only the fork path runs; the catalog never touches the provider snapshot manager here.
      providerSnapshotManager: {} as never,
      logger,
      ...extra,
    });
  }

  test("an agent forks itself into a top-level agent that works on the prompt while the source is untouched", async () => {
    const harness = await createHarness({ nativeFork: true });
    await seedConversation(harness, false);
    const catalog = catalogFor(harness, { callerAgentId: harness.sourceId });

    const response = await catalog.executeTool("fork_agent", {
      prompt: "Investigate B",
      title: "Task B",
    });

    const { forkedAgentId, method, sourceAgentId } = response.structuredContent as {
      forkedAgentId: string;
      method: string;
      sourceAgentId: string;
    };
    expect(sourceAgentId).toBe(harness.sourceId);
    expect(method).toBe("native");
    const fork = harness.manager.getAgent(forkedAgentId)!;
    expect(fork.labels).toEqual({ keep: "yes" });
    expect((await harness.storage.get(forkedAgentId))?.title).toBe("Task B");
    expect(fork.workspaceId).toBe("workspace-1");
    await vi.waitFor(() => expect(harness.prompts).toHaveLength(1));
    expect(harness.prompts[0]).toContain("Investigate B");
    expect(harness.prompts[0]).toContain("Do not continue the task");
    expect(harness.manager.getAgent(harness.sourceId)!.lifecycle).toBe("idle");
    expect(harness.manager.getAgent(harness.sourceId)!.labels["paseo.parent-agent-id"]).toBe(
      "some-parent",
    );
  });

  test("without a prompt the fork stays idle", async () => {
    const harness = await createHarness({ nativeFork: true });
    await seedConversation(harness, false);
    const catalog = catalogFor(harness, { callerAgentId: harness.sourceId });

    await catalog.executeTool("fork_agent", {});

    expect(harness.prompts).toEqual([]);
  });

  test("a caller that is not an agent must name the source", async () => {
    const harness = await createHarness({ nativeFork: true });
    const catalog = catalogFor(harness);

    await expect(catalog.executeTool("fork_agent", {})).rejects.toThrow(/agentId is required/);
  });

  test("a fork cannot move to another workspace", async () => {
    const harness = await createHarness({ nativeFork: true });
    const catalog = catalogFor(harness, { callerAgentId: harness.sourceId });

    await expect(catalog.executeTool("fork_agent", { workspaceId: "workspace-2" })).rejects.toThrow(
      /stays in the source agent's workspace/,
    );
  });

  describe("serverId routing", () => {
    function remoteHarness() {
      const calls: string[] = [];
      const client = {
        fetchAgent: async (id: string) => ({ agent: { id, workspaceId: "remote-ws" } }),
        forkAgent: async (id: string) => {
          calls.push(`fork:${id}`);
          return { forkedAgentId: "remote-fork", method: "native" };
        },
        updateAgent: async (id: string, update: { name?: string }) => {
          calls.push(`rename:${id}:${update.name}`);
        },
        sendMessage: async (id: string, text: string) => {
          calls.push(`send:${id}:${text.includes("Do B") ? "task" : "other"}`);
          return {};
        },
      };
      const used: string[] = [];
      const hosts = {
        directory: () => [],
        use: async (serverId: string, action: (c: unknown) => Promise<unknown>) => {
          used.push(serverId);
          return action(client);
        },
      } as unknown as ToolHosts;
      return { calls, used, hosts };
    }

    test("forks on the destination host from a source that lives there", async () => {
      const harness = await createHarness({ nativeFork: true });
      const remote = remoteHarness();
      const catalog = catalogFor(harness, {
        callerAgentId: harness.sourceId,
        serverId: "host-a",
        hosts: () => remote.hosts,
      });

      const response = await catalog.executeTool("fork_agent", {
        serverId: "host-b",
        agentId: "remote-source",
        prompt: "Do B",
        title: "B",
      });

      expect(remote.used).toEqual(["host-b"]);
      expect(response.structuredContent).toMatchObject({
        forkedAgentId: "remote-fork",
        method: "native",
        serverId: "host-b",
      });
      expect(remote.calls).toEqual([
        "fork:remote-source",
        "rename:remote-fork:B",
        "send:remote-fork:task",
      ]);
      expect(harness.manager.listAgents()).toHaveLength(1);
    });

    test("refuses to fork the caller's own session onto another host", async () => {
      const harness = await createHarness({ nativeFork: true });
      const remote = remoteHarness();
      const catalog = catalogFor(harness, {
        callerAgentId: harness.sourceId,
        serverId: "host-a",
        hosts: () => remote.hosts,
      });

      const response = await catalog.executeTool("fork_agent", { serverId: "host-b" });

      expect(response.isError).toBe(true);
      expect(JSON.stringify(response.structuredContent)).toContain("same host");
      expect(remote.calls).toEqual([]);
    });
  });
});
