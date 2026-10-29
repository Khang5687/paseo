import { describe, expect, it } from "vitest";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { normalizeAgentSnapshot, projectAgentSnapshot } from "./agent-snapshots";

function createSnapshot(
  input: Partial<Omit<AgentSnapshotPayload, "labels">> & {
    labels?: Record<string, unknown>;
  } = {},
): AgentSnapshotPayload {
  return {
    id: input.id ?? "agent-1",
    provider: input.provider ?? "codex",
    cwd: input.cwd ?? "/repo",
    model: input.model ?? null,
    createdAt: input.createdAt ?? "2026-04-20T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-04-20T00:01:00.000Z",
    lastUserMessageAt: input.lastUserMessageAt ?? null,
    status: input.status ?? "idle",
    activeTurn: input.activeTurn,
    capabilities: input.capabilities ?? {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: input.currentModeId ?? null,
    availableModes: input.availableModes ?? [],
    pendingPermissions: input.pendingPermissions ?? [],
    persistence: input.persistence ?? null,
    title: input.title ?? null,
    labels: (input.labels ?? {}) as AgentSnapshotPayload["labels"],
    ...(input.queuedMessages ? { queuedMessages: input.queuedMessages } : {}),
    ...(input.queuePaused !== undefined ? { queuePaused: input.queuePaused } : {}),
    ...(input.queuePauseReason !== undefined ? { queuePauseReason: input.queuePauseReason } : {}),
  };
}

describe("normalizeAgentSnapshot", () => {
  it("round-trips identified active turns through the canonical snapshot boundary", () => {
    const snapshot = createSnapshot({
      status: "running",
      activeTurn: { turnId: "turn-1", startedAt: "2026-07-31T12:00:00.000Z" },
    });

    expect(projectAgentSnapshot(normalizeAgentSnapshot(snapshot, "server-1"))).toMatchObject({
      status: "running",
      activeTurn: snapshot.activeTurn,
    });
  });

  it("carries daemon queue summaries through and defaults them for older daemons", () => {
    const queuedMessages = [
      {
        id: "q-1",
        text: "after this turn",
        imageCount: 1,
        attachmentCount: 0,
        createdAt: "2026-10-02T00:00:00.000Z",
      },
    ];
    const withQueue = normalizeAgentSnapshot(createSnapshot({ queuedMessages }), "server-1");
    expect(withQueue.queuedMessages).toEqual(queuedMessages);
    expect(projectAgentSnapshot(withQueue).queuedMessages).toEqual(queuedMessages);

    // COMPAT(messageQueue): snapshots from daemons without the queue omit the field.
    const legacy = normalizeAgentSnapshot(createSnapshot(), "server-1");
    expect(legacy.queuedMessages).toEqual([]);
  });

  it("carries the paused queue flag and treats its absence as not paused", () => {
    const paused = normalizeAgentSnapshot(createSnapshot({ queuePaused: true }), "server-1");
    expect(paused.queuePaused).toBe(true);
    expect(projectAgentSnapshot(paused).queuePaused).toBe(true);

    // COMPAT(messageQueueControls): snapshots from hosts without queue controls omit the field.
    const legacy = normalizeAgentSnapshot(createSnapshot(), "server-1");
    expect(legacy.queuePaused).toBe(false);
  });

  it("carries why the host paused the queue, and nothing when it gave no reason", () => {
    const failed = normalizeAgentSnapshot(
      createSnapshot({ queuePaused: true, queuePauseReason: "provider unavailable" }),
      "server-1",
    );
    expect(failed.queuePauseReason).toBe("provider unavailable");
    expect(projectAgentSnapshot(failed).queuePauseReason).toBe("provider unavailable");

    // COMPAT(queuePauseReason): hosts without the field, and user pauses, omit it.
    const userPaused = normalizeAgentSnapshot(createSnapshot({ queuePaused: true }), "server-1");
    expect(userPaused.queuePauseReason).toBeNull();
    expect(projectAgentSnapshot(userPaused)).not.toHaveProperty("queuePauseReason");
  });

  it("normalizes identified and legacy active turns at the snapshot boundary", () => {
    const startedAt = "2026-07-31T12:00:00.000Z";
    expect(
      normalizeAgentSnapshot(
        createSnapshot({
          status: "running",
          activeTurn: { turnId: "turn-1", startedAt },
        }),
        "server-1",
      ).turn,
    ).toEqual({
      phase: "open",
      turnId: "turn-1",
      startedAt: new Date(startedAt),
      cancellationRequestId: null,
    });

    expect(
      normalizeAgentSnapshot(
        createSnapshot({ status: "running", lastUserMessageAt: startedAt }),
        "server-1",
      ).turn,
    ).toEqual({
      phase: "open",
      turnId: null,
      startedAt: new Date(startedAt),
      cancellationRequestId: null,
    });
  });

  it("derives parentAgentId from the parent label while preserving labels", () => {
    const labels = {
      [PARENT_AGENT_ID_LABEL]: "parent-1",
      "custom.label": "still-here",
    };

    const agent = normalizeAgentSnapshot(createSnapshot({ labels }), "server-1");

    expect(agent.parentAgentId).toBe("parent-1");
    expect(agent.labels).toEqual(labels);
  });

  it("trims whitespace around the parent label", () => {
    const agent = normalizeAgentSnapshot(
      createSnapshot({ labels: { [PARENT_AGENT_ID_LABEL]: "  parent-1 \n" } }),
      "server-1",
    );

    expect(agent.parentAgentId).toBe("parent-1");
  });

  it("maps missing, empty, and non-string parent labels to null", () => {
    const missing = normalizeAgentSnapshot(createSnapshot(), "server-1");
    const empty = normalizeAgentSnapshot(
      createSnapshot({ labels: { [PARENT_AGENT_ID_LABEL]: "   " } }),
      "server-1",
    );
    const nonString = normalizeAgentSnapshot(
      createSnapshot({ labels: { [PARENT_AGENT_ID_LABEL]: 42 } }),
      "server-1",
    );

    expect(missing.parentAgentId).toBeNull();
    expect(empty.parentAgentId).toBeNull();
    expect(nonString.parentAgentId).toBeNull();
  });
});
