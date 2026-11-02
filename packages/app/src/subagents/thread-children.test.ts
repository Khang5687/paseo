import { afterEach, describe, expect, it } from "vitest";
import { TURN_LIVENESS_IDLE } from "@/timeline/turn-liveness";
import { useProviderSubagentStore } from "./provider-store";
import {
  createThreadProviderRowsSelector,
  type PaseoSubagentRow,
  type ProviderSubagentRow,
} from "./select";
import { buildThreadAgentIndex, buildThreadChildRows, type ThreadAgents } from "./thread-children";

afterEach(() => {
  useProviderSubagentStore.setState({
    descriptors: new Map(),
    timelines: new Map(),
    hiddenFromTrack: new Set(),
  });
});

interface TestAgent {
  id: string;
  workspaceId: string;
  parentAgentId: string | null;
  archivedAt: Date | null;
  createdAt: Date;
}

function agent(
  id: string,
  workspaceId: string,
  options: { parent?: string; archived?: boolean; createdAt?: number } = {},
): TestAgent {
  return {
    id,
    workspaceId,
    parentAgentId: options.parent ?? null,
    archivedAt: options.archived ? new Date(0) : null,
    createdAt: new Date(options.createdAt ?? 0),
  };
}

function agentMap(...agents: TestAgent[]): Map<string, TestAgent> {
  return new Map(agents.map((entry) => [entry.id, entry]));
}

function childIds(index: Map<string, ThreadAgents<TestAgent>>, workspaceId: string) {
  return index.get(workspaceId)?.children.map((entry) => entry.id);
}

describe("buildThreadAgentIndex", () => {
  it("lists same-workspace subagents and their descendants under the thread, oldest first", () => {
    const index = buildThreadAgentIndex(
      agentMap(
        agent("parent", "ws-a"),
        agent("grandchild", "ws-a", { parent: "child-1", createdAt: 3 }),
        agent("child-2", "ws-a", { parent: "parent", createdAt: 2 }),
        agent("child-1", "ws-a", { parent: "parent", createdAt: 1 }),
      ),
    );

    expect(childIds(index, "ws-a")).toEqual(["child-1", "child-2", "grandchild"]);
    expect(index.get("ws-a")?.agentIds).toEqual(["parent", "grandchild", "child-2", "child-1"]);
  });

  it("leaves a cross-workspace subagent out of its parent's thread; its workspace nests instead", () => {
    const index = buildThreadAgentIndex(
      agentMap(agent("parent", "ws-a"), agent("worker", "ws-b", { parent: "parent" })),
    );

    expect(childIds(index, "ws-a")).toEqual([]);
    expect(childIds(index, "ws-b")).toEqual([]);
    expect(index.get("ws-b")?.agentIds).toEqual(["worker"]);
  });

  it("drops archived agents, so their provider subagents and child rows disappear with them", () => {
    const index = buildThreadAgentIndex(
      agentMap(
        agent("parent", "ws-a"),
        agent("done", "ws-a", { parent: "parent", archived: true }),
        agent("gone", "ws-c", { archived: true }),
      ),
    );

    expect(index.get("ws-a")).toEqual({ agentIds: ["parent"], children: [] });
    expect(index.has("ws-c")).toBe(false);
  });

  it("reuses unchanged thread entries so unrelated agent updates re-render no sidebar row", () => {
    const parent = agent("parent", "ws-a");
    const child = agent("child", "ws-a", { parent: "parent" });
    const otherParent = agent("other", "ws-b");
    const otherChild = agent("other-child", "ws-b", { parent: "other" });
    const previous = buildThreadAgentIndex(agentMap(parent, child, otherParent, otherChild));

    // A thread head's own updates reach its row through the workspace entry, not this index.
    expect(
      buildThreadAgentIndex(agentMap({ ...parent }, child, otherParent, otherChild), previous),
    ).toBe(previous);

    const next = buildThreadAgentIndex(
      agentMap(parent, child, otherParent, { ...otherChild }),
      previous,
    );
    expect(next).not.toBe(previous);
    expect(next.get("ws-a")).toBe(previous.get("ws-a"));
    expect(next.get("ws-b")).not.toBe(previous.get("ws-b"));
  });
});

describe("buildThreadChildRows", () => {
  function providerRow(id: string, createdAt: number): ProviderSubagentRow {
    return {
      kind: "provider",
      id,
      parentAgentId: "parent",
      provider: "omp",
      title: "task",
      description: id,
      subtitle: null,
      status: "running",
      requiresAttention: false,
      createdAt: new Date(createdAt),
    };
  }

  function paseoRow(id: string, createdAt: number): PaseoSubagentRow {
    return {
      kind: "paseo",
      address: { serverId: "srv", agentId: id },
      id,
      provider: "omp",
      title: id,
      description: null,
      subtitle: null,
      status: "idle",
      turn: TURN_LIVENESS_IDLE,
      requiresAttention: false,
      createdAt: new Date(createdAt),
    };
  }

  it("interleaves Paseo and provider subagents by when they started", () => {
    const rows = buildThreadChildRows({
      children: [paseoRow("paseo-1", 1), paseoRow("paseo-3", 3)],
      providerRows: [providerRow("task-2", 2), providerRow("task-4", 4)],
    });

    expect(rows.map((row) => `${row.kind}:${row.id}`)).toEqual([
      "paseo:paseo-1",
      "provider:task-2",
      "paseo:paseo-3",
      "provider:task-4",
    ]);
  });
});

describe("createThreadProviderRowsSelector", () => {
  function upsertTask(parentAgentId: string, id: string, serverId = "srv") {
    useProviderSubagentStore.getState().applyUpdate(serverId, {
      kind: "upsert",
      subagent: {
        id,
        parentAgentId,
        parentSubagentId: null,
        provider: "omp",
        title: "task",
        description: id,
        status: "completed",
        createdAt: "2026-10-23T19:05:42.000Z",
        updatedAt: "2026-10-23T19:06:42.000Z",
        toolCallId: `call-${id}`,
      },
    });
  }

  it("collects provider subagents of every agent in the thread and skips dismissed ones", () => {
    upsertTask("parent", "SyncApp");
    upsertTask("same-workspace-child", "SyncServer");
    upsertTask("parent", "Dismissed");
    upsertTask("other-thread", "Elsewhere");
    upsertTask("parent", "OtherHost", "srv-2");
    useProviderSubagentStore.getState().hideFromTrack("srv", "parent", ["Dismissed"]);
    const select = createThreadProviderRowsSelector({
      serverId: "srv",
      agentIds: ["parent", "same-workspace-child"],
      supported: true,
      nestingSupported: true,
    });

    const rows = select(useProviderSubagentStore.getState());
    expect(rows.map((row) => `${row.parentAgentId}/${row.id}`)).toEqual([
      "parent/SyncApp",
      "same-workspace-child/SyncServer",
    ]);
    expect(select(useProviderSubagentStore.getState())).toBe(rows);
  });

  it("shows no provider rows on a host without provider subagents", () => {
    upsertTask("parent", "SyncApp");
    const select = createThreadProviderRowsSelector({
      serverId: "srv",
      agentIds: ["parent"],
      supported: false,
      nestingSupported: false,
    });

    expect(select(useProviderSubagentStore.getState())).toEqual([]);
  });
});
