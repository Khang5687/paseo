import { describe, expect, it } from "vitest";
import { buildHostVoiceDirectory, findVoiceChatsOnHosts } from "./voice-host-chats";
import type { SessionState } from "@/stores/session-store";

type HostSession = Pick<SessionState, "projects" | "workspaces" | "agents">;

function hostSession(): HostSession {
  const workspace = (id: string, projectId: string, archivingAt: string | null = null) =>
    [
      id,
      {
        id,
        projectId,
        projectDisplayName: projectId === "p-fit" ? "fitness" : "groceries",
        projectCustomName: projectId === "p-fit" ? "FitUp" : null,
        archivingAt,
      },
    ] as const;
  const agent = (id: string, workspaceId: string, extra: Record<string, unknown> = {}) =>
    [
      id,
      {
        id,
        workspaceId,
        title: id,
        labels: {},
        updatedAt: new Date("2026-11-28T00:00:00.000Z"),
        lastUserMessageAt: null,
        ...extra,
      },
    ] as const;
  return {
    // Only FitUp is in the project list yet; Groceries is known from its workspace.
    projects: new Map([
      ["p-fit", { projectId: "p-fit", projectDisplayName: "fitness", projectCustomName: "FitUp" }],
    ]),
    workspaces: new Map([
      workspace("w-food", "p-fit"),
      workspace("w-old", "p-fit", "2026-11-28T00:00:00.000Z"),
      workspace("w-shop", "p-groc"),
    ]),
    agents: new Map([
      agent("Food scan", "w-food", { lastUserMessageAt: new Date("2026-11-28T10:00:00.000Z") }),
      agent("Gym log", "w-food"),
      agent("Being archived", "w-old"),
      agent("Background job", "w-food", { background: true }),
      agent("Shopping list", "w-shop"),
    ]),
  } as unknown as HostSession;
}

describe("voice chats on the app's other hosts", () => {
  it("builds a host's projects and chats from the app's copy of it", () => {
    expect(buildHostVoiceDirectory(hostSession())).toEqual([
      {
        projectId: "p-fit",
        name: "FitUp",
        chats: [
          expect.objectContaining({ agentId: "Food scan" }),
          expect.objectContaining({ agentId: "Gym log" }),
        ],
      },
      {
        projectId: "p-groc",
        name: "groceries",
        chats: [expect.objectContaining({ agentId: "Shopping list" })],
      },
    ]);
  });

  it("finds a spoken name, and the one chat 'go back' asks for, with the host's state", () => {
    const hosts = [
      {
        serverId: "mac",
        hostName: "Mac",
        online: false,
        projects: buildHostVoiceDirectory(hostSession()),
      },
    ];
    expect(findVoiceChatsOnHosts({ kind: "name", target: "fitup gym log" }, hosts)).toEqual([
      expect.objectContaining({ serverId: "mac", online: false, chatAgentId: "Gym log" }),
    ]);
    expect(
      findVoiceChatsOnHosts({ kind: "chat", serverId: "mac", agentId: "Shopping list" }, hosts),
    ).toEqual([
      expect.objectContaining({
        hostName: "Mac",
        chatAgentId: "Shopping list",
        project: expect.objectContaining({ name: "groceries" }),
      }),
    ]);
    expect(
      findVoiceChatsOnHosts({ kind: "chat", serverId: "mac", agentId: "Being archived" }, hosts),
    ).toEqual([]);
  });
});
