import { describe, expect, test } from "vitest";
import { PARENT_AGENT_ID_LABEL } from "../agent-labels.js";
import { buildVoiceChatDirectory } from "./chat-directory.js";

function agent(
  id: string,
  workspaceId: string,
  overrides: Partial<Parameters<typeof buildVoiceChatDirectory>[0]["agents"][number]> = {},
) {
  return {
    id,
    workspaceId,
    title: id,
    labels: {},
    lastUserMessageAt: null,
    updatedAt: "2026-11-28T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildVoiceChatDirectory", () => {
  test("a chat is a top-level agent that is not archived, in an active workspace", () => {
    const directory = buildVoiceChatDirectory({
      projects: [
        { projectId: "p1", displayName: "paseo", customName: "Paseo fork", archivedAt: null },
        { projectId: "p2", displayName: "old", customName: null, archivedAt: "2026-11-01" },
      ],
      workspaces: [
        { workspaceId: "w1", projectId: "p1" },
        { workspaceId: "w2", projectId: "p1" },
        { workspaceId: "w3", projectId: "p2" },
      ],
      agents: [
        agent("older", "w1", { lastUserMessageAt: "2026-11-27T10:00:00.000Z" }),
        agent("newer", "w2", { lastUserMessageAt: "2026-11-28T10:00:00.000Z" }),
        agent("subagent", "w1", { labels: { [PARENT_AGENT_ID_LABEL]: "newer" } }),
        agent("archived", "w1", { archivedAt: "2026-11-28T09:00:00.000Z" }),
        agent("internal", "w1", { internal: true }),
        agent("archived-workspace", "w-gone"),
        agent("archived-project", "w3"),
      ],
    });

    expect(directory).toEqual([
      {
        projectId: "p1",
        name: "Paseo fork",
        chats: [
          expect.objectContaining({ agentId: "newer", workspaceId: "w2" }),
          expect.objectContaining({ agentId: "older", workspaceId: "w1" }),
        ],
      },
    ]);
  });
});
