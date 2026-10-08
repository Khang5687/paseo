import { describe, expect, it } from "vitest";
import { buildWorkspaceParentIndex } from "./workspace-parents";

interface TestAgent {
  id: string;
  workspaceId: string;
  parentAgentId: string | null;
  archivedAt: Date | null;
}

function agent(input: {
  id: string;
  workspaceId: string;
  parentAgentId?: string;
  archived?: boolean;
}): TestAgent {
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    parentAgentId: input.parentAgentId ?? null,
    archivedAt: input.archived ? new Date("2026-10-08T12:00:00.000Z") : null,
  };
}

function index(agents: TestAgent[]): Record<string, string> {
  return Object.fromEntries(
    buildWorkspaceParentIndex(new Map(agents.map((entry) => [entry.id, entry]))),
  );
}

const root = agent({ id: "root", workspaceId: "main" });

describe("buildWorkspaceParentIndex", () => {
  it("nests a workspace whose agents are all subagents of one other workspace", () => {
    expect(
      index([
        root,
        agent({ id: "worker-a", workspaceId: "feature", parentAgentId: "root" }),
        agent({ id: "worker-b", workspaceId: "feature", parentAgentId: "root" }),
      ]),
    ).toEqual({ feature: "main" });
  });

  it("keeps a workspace with a root agent beside its subagents at the top level", () => {
    expect(
      index([
        root,
        agent({ id: "worker", workspaceId: "feature", parentAgentId: "root" }),
        agent({ id: "own-root", workspaceId: "feature" }),
      ]),
    ).toEqual({});
  });

  it("keeps a workspace holding subagents of two different workspaces at the top level", () => {
    expect(
      index([
        root,
        agent({ id: "other-root", workspaceId: "other" }),
        agent({ id: "worker-a", workspaceId: "feature", parentAgentId: "root" }),
        agent({ id: "worker-b", workspaceId: "feature", parentAgentId: "other-root" }),
      ]),
    ).toEqual({});
  });

  it("ignores the subagent's own helpers in its workspace", () => {
    expect(
      index([
        root,
        agent({ id: "worker", workspaceId: "feature", parentAgentId: "root" }),
        agent({ id: "helper", workspaceId: "feature", parentAgentId: "worker" }),
      ]),
    ).toEqual({ feature: "main" });
  });

  it("un-nests when the parent agent is archived or gone", () => {
    expect(
      index([
        agent({ id: "root", workspaceId: "main", archived: true }),
        agent({ id: "worker", workspaceId: "feature", parentAgentId: "root" }),
      ]),
    ).toEqual({});
    expect(index([agent({ id: "worker", workspaceId: "feature", parentAgentId: "root" })])).toEqual(
      {},
    );
  });

  it("un-nests when the subagent is detached", () => {
    expect(index([root, agent({ id: "worker", workspaceId: "feature" })])).toEqual({});
  });

  it("drops a workspace whose only agents are archived", () => {
    expect(
      index([
        root,
        agent({ id: "worker", workspaceId: "feature", parentAgentId: "root", archived: true }),
      ]),
    ).toEqual({});
  });

  it("chains a subagent's own subagent workspace under the subagent's workspace", () => {
    expect(
      index([
        root,
        agent({ id: "worker", workspaceId: "feature", parentAgentId: "root" }),
        agent({ id: "reviewer", workspaceId: "review", parentAgentId: "worker" }),
      ]),
    ).toEqual({ feature: "main", review: "feature" });
  });

  it("records a parent cycle without looping", () => {
    expect(
      index([
        agent({ id: "a", workspaceId: "one", parentAgentId: "b" }),
        agent({ id: "b", workspaceId: "two", parentAgentId: "a" }),
      ]),
    ).toEqual({ one: "two", two: "one" });
  });

  it("returns the previous index when the relationships are unchanged", () => {
    const agents = new Map([
      ["root", root],
      ["worker", agent({ id: "worker", workspaceId: "feature", parentAgentId: "root" })],
    ]);
    const previous = buildWorkspaceParentIndex(agents);

    expect(buildWorkspaceParentIndex(new Map(agents), previous)).toBe(previous);
  });
});
