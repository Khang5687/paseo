import { describe, expect, it } from "vitest";
import { buildDraftStoreKey, buildNewWorkspaceDraftKey } from "./draft-keys";

describe("buildDraftStoreKey", () => {
  it("isolates agent drafts by server and agent ids", () => {
    const keyA = buildDraftStoreKey({
      serverId: "server-a",
      agentId: "agent-1",
    });
    const keyB = buildDraftStoreKey({
      serverId: "server-b",
      agentId: "agent-1",
    });
    const keyC = buildDraftStoreKey({
      serverId: "server-a",
      agentId: "agent-2",
    });

    expect(keyA).not.toBe(keyB);
    expect(keyA).not.toBe(keyC);
    expect(keyB).not.toBe(keyC);
  });

  it("uses draftId keyspace for create flow drafts", () => {
    const key = buildDraftStoreKey({
      serverId: "server-a",
      agentId: "__new_agent__",
      draftId: "draft-123",
    });

    expect(key).toBe("draft:server-a:draft-123");
  });
});

describe("buildNewWorkspaceDraftKey", () => {
  it("gives each entry project its own draft", () => {
    const paseo = buildNewWorkspaceDraftKey({ serverId: "local", sourceDirectory: "/repo/paseo" });
    const fretz = buildNewWorkspaceDraftKey({ serverId: "local", sourceDirectory: "/repo/fretz" });
    const remotePaseo = buildNewWorkspaceDraftKey({
      serverId: "remote",
      sourceDirectory: "/repo/paseo",
    });
    const noProject = buildNewWorkspaceDraftKey({ serverId: "local" });

    expect(new Set([paseo, fretz, remotePaseo, noProject]).size).toBe(4);
  });

  it("reuses the project draft whether or not the entry point passes a project id", () => {
    expect(
      buildNewWorkspaceDraftKey({
        serverId: "local",
        sourceDirectory: "/repo/paseo",
        projectId: "prj_paseo",
      }),
    ).toBe(buildNewWorkspaceDraftKey({ serverId: "local", sourceDirectory: "/repo/paseo" }));
  });

  it("keeps forked drafts separate from the project draft", () => {
    expect(
      buildNewWorkspaceDraftKey({
        serverId: "local",
        sourceDirectory: "/repo/paseo",
        draftId: "draft-1",
      }),
    ).not.toBe(buildNewWorkspaceDraftKey({ serverId: "local", sourceDirectory: "/repo/paseo" }));
  });
});
