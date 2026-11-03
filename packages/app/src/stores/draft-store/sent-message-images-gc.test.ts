import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AttachmentMetadata } from "@/attachments/types";
import { createUserMessage } from "@/types/stream";

const { asyncStorage, gcCalls } = vi.hoisted(() => ({
  asyncStorage: new Map<string, string>(),
  gcCalls: [] as ReadonlySet<string>[],
}));

vi.hoisted(() => {
  (globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;
});

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => asyncStorage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      asyncStorage.set(key, value);
    },
    removeItem: async (key: string) => {
      asyncStorage.delete(key);
    },
  },
}));

vi.mock("@/attachments/service", () => ({
  garbageCollectAttachments: async (input: { referencedIds: ReadonlySet<string> }) => {
    gcCalls.push(input.referencedIds);
  },
  persistAttachmentFromDataUrl: async () => {
    throw new Error("unused");
  },
  persistAttachmentFromFileUri: async () => {
    throw new Error("unused");
  },
}));

const { useDraftStore } = await import("@/stores/draft-store");
const { useSessionStore } = await import("@/stores/session-store");
const { useSentMessageImagesStore } = await import("@/stores/sent-message-images-store");

const SERVER_ID = "server-1";
const AGENT_ID = "agent-1";

function image(id: string): AttachmentMetadata {
  return {
    id,
    mimeType: "image/png",
    storageType: "web-indexeddb",
    storageKey: id,
    createdAt: 1,
  };
}

async function runGc(): Promise<ReadonlySet<string>> {
  const before = gcCalls.length;
  // Any draft write schedules a GC pass.
  useDraftStore.getState().saveCreateModalDraft(null);
  await vi.waitFor(() => expect(gcCalls.length).toBeGreaterThan(before));
  return gcCalls[gcCalls.length - 1];
}

describe("attachment GC and sent-message images", () => {
  beforeEach(() => {
    gcCalls.length = 0;
    useSentMessageImagesStore.setState({ byAgent: {} });
    useSessionStore.getState().initializeSession(SERVER_ID, null as unknown as DaemonClient);
  });

  it("keeps images of a sent message after the timeline is replaced with rows that carry none", async () => {
    useSentMessageImagesStore.getState().record({
      serverId: SERVER_ID,
      agentId: AGENT_ID,
      messageId: "client-1",
      images: [image("img-1")],
    });
    const optimistic = createUserMessage({
      clientMessageId: "client-1",
      text: "look",
      timestamp: new Date(1),
      images: [image("img-1")],
    });
    useSessionStore
      .getState()
      .setAgentStreamState(SERVER_ID, AGENT_ID, { tail: [optimistic], head: [] });
    expect([...(await runGc())]).toContain("img-1");

    // Rewind / reload: the daemon rebuilds the row without images.
    const canonical = createUserMessage({
      messageId: "daemon-1",
      clientMessageId: "client-1",
      text: "look",
      timestamp: new Date(1),
    });
    useSessionStore
      .getState()
      .setAgentStreamState(SERVER_ID, AGENT_ID, { tail: [canonical], head: [] });
    expect([...(await runGc())]).toContain("img-1");
  });

  it("stops referencing an image once its sent-message entry is removed", async () => {
    useSentMessageImagesStore.getState().record({
      serverId: SERVER_ID,
      agentId: AGENT_ID,
      messageId: "client-1",
      images: [image("img-1")],
    });
    useSentMessageImagesStore
      .getState()
      .remove({ serverId: SERVER_ID, agentId: AGENT_ID, messageId: "client-1" });

    expect([...(await runGc())]).not.toContain("img-1");
  });
});
