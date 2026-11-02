import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import { forkAgent } from "./fork-agent.js";
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
    labels: { keep: "yes", "paseo.open-agent-tab.client": "true" },
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
