import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentDraft,
  AgentDraftState,
  SessionOutboundMessage,
} from "@getpaseo/protocol/messages";
import type { DraftInput } from "@/stores/draft-store";
import {
  AgentDraftSyncController,
  DRAFT_PUSH_INTERVAL_MS,
  DRAFT_TYPING_GUARD_MS,
  type AgentDraftSyncClient,
  type AgentDraftSyncLocal,
  type LocalDraft,
} from "./agent-draft-sync";

const AGENT_ID = "agent-1";

type SetInput = Parameters<AgentDraftSyncClient["setAgentDraft"]>[0];

function remoteDraft(text: string, revision: number, updatedAt = Date.now()): AgentDraft {
  return { text, attachments: [], revision, updatedAt, updatedBy: "phone" };
}

function createHarness(initial: { text: string; synced: boolean } | null) {
  let record: LocalDraft | null = initial
    ? {
        input: { text: initial.text, attachments: [] },
        lifecycle: "active",
        version: 1,
        updatedAt: Date.now(),
        synced: initial.synced,
      }
    : null;
  const listeners = new Set<() => void>();
  const shown: string[] = [];
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const write = (input: DraftInput, synced: boolean, updatedAt = Date.now()) => {
    const empty = input.text.length === 0 && input.attachments.length === 0;
    record = {
      input,
      lifecycle: empty ? "abandoned" : "active",
      version: (record?.version ?? 0) + 1,
      updatedAt,
      synced,
    };
    notify();
  };
  const local: AgentDraftSyncLocal = {
    read: () => record,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    apply: (input, updatedAt) => {
      write(input, true, updatedAt);
      shown.push(input.text);
    },
    markSynced: (version) => {
      if (record && record.version === version) record = { ...record, synced: true };
    },
    setImageUploadId: () => {},
  };

  const pushes: SetInput[] = [];
  let serverDraft: AgentDraft | null = null;
  let observer: {
    snapshot(response: { state: AgentDraftState | null }): void;
    update(message: SessionOutboundMessage): void;
  } | null = null;
  const client: AgentDraftSyncClient = {
    observeAgentDraft: () => ({
      subscribe: (next) => {
        observer = next;
        return () => {
          observer = null;
        };
      },
      release: async () => {},
    }),
    setAgentDraft: async (input) => {
      pushes.push(input);
      const stale = serverDraft !== null && input.baseRevision !== serverDraft.revision;
      if (serverDraft && stale && input.updatedAt < serverDraft.updatedAt) {
        return { accepted: false, state: { draft: serverDraft, history: [] } };
      }
      serverDraft = {
        text: input.text,
        attachments: input.attachments,
        revision: (serverDraft?.revision ?? 0) + 1,
        updatedAt: input.updatedAt,
        updatedBy: "mac",
      };
      return { accepted: true, state: { draft: serverDraft, history: [] } };
    },
    restoreAgentDraft: async () => ({ state: null }),
    getAgentDraftUpload: async () => ({ data: "" }),
    uploadFile: async () => ({ file: null, error: "unused" }),
  };
  const controller = new AgentDraftSyncController({
    agentId: AGENT_ID,
    client,
    local,
    media: {
      readImageBytes: async () => new Uint8Array(),
      saveImage: async () => {
        throw new Error("unused");
      },
    },
    onHistory: () => {},
  });

  return {
    controller,
    pushes,
    shown,
    text: () => (record?.lifecycle === "active" ? record.input.text : ""),
    synced: () => record?.synced ?? false,
    type: (text: string) => write({ text, attachments: [] }, false),
    send: () => {
      if (!record) return;
      record = {
        input: { text: "", attachments: [] },
        lifecycle: "sent",
        version: record.version + 1,
        updatedAt: Date.now(),
        synced: false,
      };
      notify();
    },
    setServerDraft: (draft: AgentDraft | null) => {
      serverDraft = draft;
    },
    snapshot: () => observer?.snapshot({ state: { draft: serverDraft, history: [] } }),
    remoteUpdate: (draft: AgentDraft) => {
      serverDraft = draft;
      observer?.update({
        type: "agent.draft.update",
        payload: { agentId: AGENT_ID, draft },
      });
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("AgentDraftSyncController", () => {
  it("pushes a burst of keystrokes as a few throttled updates ending in the latest text", async () => {
    const harness = createHarness(null);
    harness.controller.start();
    harness.snapshot();

    for (const text of ["f", "fi", "fix", "fix ", "fix t", "fix the"]) {
      harness.type(text);
      await vi.advanceTimersByTimeAsync(50);
    }
    await vi.advanceTimersByTimeAsync(DRAFT_PUSH_INTERVAL_MS * 2);

    expect(harness.pushes.length).toBeLessThanOrEqual(2);
    expect(harness.pushes.at(-1)?.text).toBe("fix the");
    expect(harness.synced()).toBe(true);
    harness.controller.stop();
  });

  it("holds remote text while the user types and applies it once they pause", async () => {
    const harness = createHarness(null);
    harness.controller.start();
    harness.snapshot();
    harness.type("local words");
    await vi.advanceTimersByTimeAsync(DRAFT_PUSH_INTERVAL_MS);

    harness.remoteUpdate(remoteDraft("text from the phone", 2));
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.text()).toBe("local words");

    await vi.advanceTimersByTimeAsync(DRAFT_TYPING_GUARD_MS);
    expect(harness.text()).toBe("text from the phone");
    expect(harness.shown).toEqual(["text from the phone"]);
    // Applying remote text is not a local edit, so nothing echoes back.
    const pushCount = harness.pushes.length;
    await vi.advanceTimersByTimeAsync(DRAFT_PUSH_INTERVAL_MS * 2);
    expect(harness.pushes).toHaveLength(pushCount);
    harness.controller.stop();
  });

  it("applies a remote draft right away when the user is idle", async () => {
    const harness = createHarness({ text: "old", synced: true });
    harness.setServerDraft(remoteDraft("old", 1));
    harness.controller.start();
    harness.snapshot();

    harness.remoteUpdate(remoteDraft("new from the mac", 2));
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.text()).toBe("new from the mac");
    expect(harness.pushes).toEqual([]);
    harness.controller.stop();
  });

  it("pushes an offline edit on reconnect against the last revision it saw", async () => {
    const harness = createHarness({ text: "edited offline", synced: false });
    harness.setServerDraft(remoteDraft("server copy", 4, Date.now() - 60_000));
    harness.controller.start();
    harness.snapshot();
    await vi.advanceTimersByTimeAsync(DRAFT_PUSH_INTERVAL_MS);

    expect(harness.pushes).toHaveLength(1);
    expect(harness.pushes[0]).toMatchObject({ text: "edited offline", baseRevision: null });
    expect(harness.text()).toBe("edited offline");
    harness.controller.stop();
  });

  it("takes the server copy on reconnect when this device made no edits", async () => {
    const harness = createHarness({ text: "stale copy", synced: true });
    harness.setServerDraft(remoteDraft("newer from the phone", 7));
    harness.controller.start();
    harness.snapshot();
    await vi.advanceTimersByTimeAsync(DRAFT_PUSH_INTERVAL_MS);

    expect(harness.pushes).toEqual([]);
    expect(harness.text()).toBe("newer from the phone");
    harness.controller.stop();
  });

  it("loses an older offline edit to a newer server draft", async () => {
    const harness = createHarness({ text: "older offline edit", synced: false });
    harness.setServerDraft(remoteDraft("newer from the phone", 3, Date.now() + 60_000));
    harness.controller.start();
    harness.snapshot();
    await vi.advanceTimersByTimeAsync(DRAFT_PUSH_INTERVAL_MS + DRAFT_TYPING_GUARD_MS);

    expect(harness.text()).toBe("newer from the phone");
    harness.controller.stop();
  });

  it("marks the clear after a send so the daemon clears every device", async () => {
    const harness = createHarness(null);
    harness.controller.start();
    harness.snapshot();
    harness.type("ship it");
    await vi.advanceTimersByTimeAsync(DRAFT_PUSH_INTERVAL_MS);

    harness.send();
    await vi.advanceTimersByTimeAsync(DRAFT_PUSH_INTERVAL_MS);

    expect(harness.pushes.at(-1)).toMatchObject({ text: "", reason: "sent" });
    harness.controller.stop();
  });

  it("sends the pending keystrokes when it stops", async () => {
    const harness = createHarness(null);
    harness.controller.start();
    harness.snapshot();
    harness.type("first");
    await vi.advanceTimersByTimeAsync(DRAFT_PUSH_INTERVAL_MS);
    harness.type("first and last");

    harness.controller.stop();
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.pushes.at(-1)?.text).toBe("first and last");
  });
});
