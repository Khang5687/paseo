import { describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => {}),
    removeItem: vi.fn(async () => {}),
  },
}));

import type { DraftRecord } from "@/stores/draft-store/state";
import { createWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { collectWorkspaceDraftKeys, isUnsentDraft } from "@/stores/workspace-unsent-draft";

function record(input: Partial<DraftRecord["input"]>, lifecycle: DraftRecord["lifecycle"]) {
  return {
    input: { text: "", attachments: [], ...input },
    lifecycle,
    updatedAt: 0,
    version: 1,
  } satisfies DraftRecord;
}

describe("collectWorkspaceDraftKeys", () => {
  it("returns the composer drafts of agent and draft tabs in that workspace only", () => {
    const store = createWorkspaceLayoutStore();
    store.setState({ layoutByWorkspace: {} });
    const { openTab } = store.getState();
    openTab({
      workspaceKey: "server-1:ws-a",
      target: { kind: "agent", agentId: "agent-a" },
      intent: "new",
    });
    openTab({
      workspaceKey: "server-1:ws-a",
      target: { kind: "draft", draftId: "draft-a" },
      intent: "new",
    });
    openTab({ workspaceKey: "server-1:ws-a", target: { kind: "working_diff" }, intent: "new" });
    openTab({
      workspaceKey: "server-1:ws-b",
      target: { kind: "agent", agentId: "agent-b" },
      intent: "new",
    });

    const { layoutByWorkspace } = store.getState();

    expect(collectWorkspaceDraftKeys("server-1", layoutByWorkspace["server-1:ws-a"])).toEqual([
      "agent:server-1:agent-a",
      "draft:server-1:draft-a",
    ]);
    expect(collectWorkspaceDraftKeys("server-1", layoutByWorkspace["server-1:ws-missing"])).toEqual(
      [],
    );
  });
});

describe("isUnsentDraft", () => {
  it("counts typed text and lone attachments on an active draft", () => {
    expect(isUnsentDraft(record({ text: "fix the build" }, "active"))).toBe(true);
    const fileAttachment = {
      kind: "workspace_file",
      path: "src/index.ts",
      selection: { kind: "whole_file" },
    } as const;
    expect(isUnsentDraft(record({ attachments: [fileAttachment] }, "active"))).toBe(true);
  });

  it("ignores whitespace, sent, and abandoned drafts", () => {
    expect(isUnsentDraft(undefined)).toBe(false);
    expect(isUnsentDraft(record({ text: "  \n " }, "active"))).toBe(false);
    expect(isUnsentDraft(record({ text: "already sent" }, "sent"))).toBe(false);
    expect(isUnsentDraft(record({ text: "gave up" }, "abandoned"))).toBe(false);
  });
});
