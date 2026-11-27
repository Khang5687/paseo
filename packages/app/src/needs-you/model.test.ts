import { describe, expect, test } from "vitest";
import type { AgentOpenQuestion } from "@getpaseo/protocol/messages";
import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import type { PendingPermission } from "@/types/shared";
import { countNeedsYouChats, listNeedsYouChats, type NeedsYouSessionInput } from "./model";

function workspace(
  id: string,
  status: WorkspaceDescriptor["status"],
  enteredAt: string | null,
  extra: Partial<WorkspaceDescriptor> = {},
): WorkspaceDescriptor {
  return {
    id,
    createdAt: null,
    lastUserMessageAt: null,
    projectId: "repo",
    projectDisplayName: "Repo",
    projectRootPath: "/repo",
    workspaceDirectory: `/repo/${id}`,
    projectKind: "git",
    workspaceKind: "worktree",
    name: id,
    title: `Chat ${id}`,
    status,
    statusEnteredAt: enteredAt ? new Date(enteredAt) : null,
    archivingAt: null,
    diffStat: null,
    scripts: [],
    ...extra,
  };
}

function question(id: string): AgentOpenQuestion {
  return { id, label: id, title: `Title ${id}`, body: "", pick: "yes", askedAt: "2026-01-01" };
}

function session(input: {
  workspaces: WorkspaceDescriptor[];
  agents?: Record<string, { workspaceId: string; openQuestions?: AgentOpenQuestion[] }>;
  permissions?: PendingPermission[];
}): NeedsYouSessionInput {
  const agents = new Map<string, Agent>();
  const threadAgents = new Map<string, { agentIds: string[]; children: Agent[] }>();
  for (const [agentId, agent] of Object.entries(input.agents ?? {})) {
    agents.set(agentId, { id: agentId, openQuestions: agent.openQuestions } as Agent);
    const thread = threadAgents.get(agent.workspaceId) ?? { agentIds: [], children: [] };
    thread.agentIds.push(agentId);
    threadAgents.set(agent.workspaceId, thread);
  }
  return {
    workspaces: new Map(input.workspaces.map((entry) => [entry.id, entry])),
    workspaceAgentActivity: new Map(),
    threadAgents,
    agents,
    pendingPermissions: new Map(
      (input.permissions ?? []).map((permission) => [permission.key, permission]),
    ),
  };
}

function permissionBox(agentId: string, id: string): PendingPermission {
  return {
    key: `${agentId}:${id}`,
    agentId,
    request: { id, provider: "claude", name: "Bash", kind: "tool" } as PendingPermission["request"],
  };
}

describe("Needs you", () => {
  test("lists waiting chats on every host, the longest waiting first", () => {
    const sessions = {
      omen: session({
        workspaces: [
          workspace("new", "needs_input", "2026-01-01T12:00:00Z"),
          workspace("busy", "running", "2026-01-01T08:00:00Z"),
          workspace("unknown", "needs_input", null),
        ],
      }),
      mac: session({ workspaces: [workspace("old", "needs_input", "2026-01-01T09:00:00Z")] }),
    };

    expect(listNeedsYouChats(sessions).map((chat) => chat.key)).toEqual([
      "mac:old",
      "omen:new",
      "omen:unknown",
    ]);
    expect(countNeedsYouChats(sessions)).toBe(3);
  });

  test("leaves out hidden and archiving chats", () => {
    const sessions = {
      omen: session({
        workspaces: [
          workspace("hidden", "needs_input", "2026-01-01T09:00:00Z", { background: true }),
          workspace("going", "needs_input", "2026-01-01T09:00:00Z", {
            archivingAt: "2026-01-01T10:00:00Z",
          }),
        ],
      }),
    };

    expect(listNeedsYouChats(sessions)).toEqual([]);
    expect(countNeedsYouChats(sessions)).toBe(0);
  });

  test("gives each chat only its own agents' questions and permission boxes", () => {
    const sessions = {
      omen: session({
        workspaces: [
          workspace("a", "needs_input", "2026-01-01T09:00:00Z"),
          workspace("b", "needs_input", "2026-01-01T10:00:00Z"),
        ],
        agents: {
          main: { workspaceId: "a", openQuestions: [question("Q1"), question("Q2")] },
          quiet: { workspaceId: "a", openQuestions: [] },
          other: { workspaceId: "b", openQuestions: [question("Q1")] },
        },
        permissions: [permissionBox("other", "p1")],
      }),
    };

    const [a, b] = listNeedsYouChats(sessions);
    expect(a?.questionGroups.map((group) => [group.agentId, group.questions.length])).toEqual([
      ["main", 2],
    ]);
    expect(a?.permissions).toEqual([]);
    expect(b?.questionGroups.map((group) => group.agentId)).toEqual(["other"]);
    expect(b?.permissions.map((entry) => entry.key)).toEqual(["other:p1"]);
  });
});
