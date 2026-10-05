import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";

import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import type { AgentPromptInput } from "../agent/agent-sdk-types.js";

function promptText(prompt: AgentPromptInput): string {
  return typeof prompt === "string"
    ? prompt
    : prompt.blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

/**
 * Two clients on one daemon. A queues while the agent is parked on a permission
 * prompt, B sees the entry through its agent subscription, A answers the
 * prompt, the daemon dispatches the queued message exactly once, and both
 * clients see an empty queue.
 */
test("a message queued by one client is visible to another and dispatched once by the daemon", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "daemon-e2e-queue-"));
  const startedPrompts: string[] = [];
  let daemon: TestPaseoDaemon | null = null;
  let clientA: DaemonClient | null = null;
  let clientB: DaemonClient | null = null;
  try {
    daemon = await createTestPaseoDaemon({
      agentClients: createTestAgentClients({
        onStartTurn: (prompt) => {
          startedPrompts.push(promptText(prompt));
        },
      }),
    });
    const url = `ws://127.0.0.1:${daemon.port}/ws`;
    clientA = new DaemonClient({ url });
    clientB = new DaemonClient({ url });
    await clientA.connect();
    await clientB.connect();
    expect(clientA.getLastServerInfoMessage()?.features?.messageQueue).toBe(true);

    const snapshotsSeenByB: AgentSnapshotPayload[] = [];
    clientB.subscribeRawMessages((message) => {
      if (message.type === "agent_update" && message.payload.kind === "upsert") {
        snapshotsSeenByB.push(message.payload.agent);
      }
    });
    await clientB.fetchAgents({ subscribe: {} });

    const agent = await clientA.createAgent({ provider: "codex", cwd });

    // The fake agent asks for permission on tool use in its default mode, which
    // parks the turn until someone answers.
    await clientA.sendMessage(agent.id, "run echo hello");
    const parked = await clientA.waitForFinish(agent.id, 30_000);
    const permission = parked.final?.pendingPermissions?.[0];
    expect(permission?.id).toBeTruthy();

    const queued = await clientA.addQueuedAgentMessage({
      agentId: agent.id,
      text: "and then say goodbye",
    });
    expect(queued).toMatchObject({ text: "and then say goodbye", imageCount: 0 });

    await vi.waitFor(() => {
      const latest = snapshotsSeenByB.findLast((snapshot) => snapshot.id === agent.id);
      expect(latest?.queuedMessages).toEqual([queued]);
    });
    expect((await clientB.fetchAgent(agent.id))?.agent.queuedMessages).toEqual([queued]);

    await clientA.respondToPermission(agent.id, permission!.id, { behavior: "allow" });

    await vi.waitFor(() => {
      expect(startedPrompts).toEqual(["run echo hello", "and then say goodbye"]);
    });
    const finished = await clientA.waitForFinish(agent.id, 30_000);
    expect(finished.status).toBe("idle");
    expect(startedPrompts).toHaveLength(2);

    await vi.waitFor(() => {
      const latest = snapshotsSeenByB.findLast((snapshot) => snapshot.id === agent.id);
      expect(latest?.queuedMessages).toEqual([]);
    });
    expect((await clientA.fetchAgent(agent.id))?.agent.queuedMessages).toEqual([]);
    expect((await clientB.fetchAgent(agent.id))?.agent.queuedMessages).toEqual([]);
  } finally {
    await clientA?.close().catch(() => undefined);
    await clientB?.close().catch(() => undefined);
    await daemon?.close().catch(() => undefined);
    rmSync(cwd, { recursive: true, force: true });
  }
}, 60_000);
