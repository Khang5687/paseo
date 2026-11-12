import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AttachmentMetadata } from "@/attachments/types";

vi.hoisted(() => {
  (globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;
});

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  },
}));

const { selectSentMessageImages, useSentMessageImagesStore } =
  await import("./sent-message-images-store");

const IMAGE: AttachmentMetadata = {
  id: "img-1",
  mimeType: "image/png",
  storageType: "web-indexeddb",
  storageKey: "img-1",
  createdAt: 1,
};

describe("sent message images", () => {
  beforeEach(() => {
    useSentMessageImagesStore.setState({ byAgent: {} });
  });

  it("resolves a daemon row through the alias recorded from its optimistic row", () => {
    const store = useSentMessageImagesStore.getState();
    store.record({ serverId: "s", agentId: "a", messageId: "client-1", images: [IMAGE] });
    store.alias({
      serverId: "s",
      agentId: "a",
      fromMessageId: "client-1",
      toMessageId: "daemon-1",
    });

    const state = useSentMessageImagesStore.getState();
    expect(
      selectSentMessageImages(state, {
        serverId: "s",
        agentId: "a",
        messageIds: [undefined, "daemon-1"],
      }),
    ).toEqual([IMAGE]);
  });

  it("does not leak images across agents", () => {
    useSentMessageImagesStore
      .getState()
      .record({ serverId: "s", agentId: "a", messageId: "m", images: [IMAGE] });

    expect(
      selectSentMessageImages(useSentMessageImagesStore.getState(), {
        serverId: "s",
        agentId: "b",
        messageIds: ["m"],
      }),
    ).toEqual([]);
  });
});
