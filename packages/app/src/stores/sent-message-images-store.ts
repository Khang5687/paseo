import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import type { AttachmentMetadata } from "@/attachments/types";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import { AttachmentMetadataSchema } from "@/stores/draft-store/state";

/**
 * Daemon timelines carry no image payloads, so the only record of which
 * attachments a sent message held is the client's own optimistic row. That row
 * is gone after a reload or a timeline replacement (rewind). This store keeps
 * (serverId, agentId, message id) -> images so thumbnails can be re-attached
 * and attachment GC keeps the files.
 */

const SENT_MESSAGE_IMAGES_STORE_VERSION = 1;

type ImagesByMessageId = Record<string, AttachmentMetadata[]>;

const PersistedSchema = z.strictObject({
  byAgent: z.record(z.string(), z.record(z.string(), z.array(AttachmentMetadataSchema))),
});

interface SentMessageImagesState {
  byAgent: Record<string, ImagesByMessageId>;
  record: (input: {
    serverId: string;
    agentId: string;
    messageId: string;
    images: AttachmentMetadata[];
  }) => void;
  alias: (input: {
    serverId: string;
    agentId: string;
    fromMessageId: string;
    toMessageId: string;
  }) => void;
  remove: (input: { serverId: string; agentId: string; messageId: string }) => void;
}

export function buildSentMessageImagesAgentKey(serverId: string, agentId: string): string {
  return `${serverId}\u0000${agentId}`;
}

export const useSentMessageImagesStore = create<SentMessageImagesState>()(
  persist(
    (set) => ({
      byAgent: {},
      record: ({ serverId, agentId, messageId, images }) => {
        if (images.length === 0) return;
        const key = buildSentMessageImagesAgentKey(serverId, agentId);
        set((state) => ({
          byAgent: { ...state.byAgent, [key]: { ...state.byAgent[key], [messageId]: images } },
        }));
      },
      alias: ({ serverId, agentId, fromMessageId, toMessageId }) => {
        const key = buildSentMessageImagesAgentKey(serverId, agentId);
        set((state) => {
          const entries = state.byAgent[key];
          const images = entries?.[fromMessageId];
          if (!entries || !images || entries[toMessageId] === images) return state;
          return { byAgent: { ...state.byAgent, [key]: { ...entries, [toMessageId]: images } } };
        });
      },
      remove: ({ serverId, agentId, messageId }) => {
        const key = buildSentMessageImagesAgentKey(serverId, agentId);
        set((state) => {
          const entries = state.byAgent[key];
          if (!entries || !(messageId in entries)) return state;
          const { [messageId]: _removed, ...rest } = entries;
          return { byAgent: { ...state.byAgent, [key]: rest } };
        });
      },
    }),
    {
      name: "paseo-sent-message-images",
      version: SENT_MESSAGE_IMAGES_STORE_VERSION,
      storage: createValidatedPersistStorage(AsyncStorage, PersistedSchema),
      partialize: ({ byAgent }) => ({ byAgent }),
    },
  ),
);

const NO_IMAGES: AttachmentMetadata[] = [];

/** Looks up by the first id that has an entry; ids are tried in order. */
export function selectSentMessageImages(
  state: Pick<SentMessageImagesState, "byAgent">,
  input: { serverId?: string; agentId?: string; messageIds: ReadonlyArray<string | undefined> },
): AttachmentMetadata[] {
  if (!input.serverId || !input.agentId) return NO_IMAGES;
  const entries = state.byAgent[buildSentMessageImagesAgentKey(input.serverId, input.agentId)];
  if (!entries) return NO_IMAGES;
  for (const id of input.messageIds) {
    const images = id ? entries[id] : undefined;
    if (images) return images;
  }
  return NO_IMAGES;
}

export function collectSentMessageImageIds(): Set<string> {
  const ids = new Set<string>();
  for (const entries of Object.values(useSentMessageImagesStore.getState().byAgent)) {
    for (const images of Object.values(entries)) {
      for (const image of images) ids.add(image.id);
    }
  }
  return ids;
}

/** GC must not run against an index that has not loaded; it would delete every sent image. */
export function waitForSentMessageImagesHydration(): Promise<void> {
  const { persist: persistApi } = useSentMessageImagesStore;
  if (persistApi.hasHydrated()) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = persistApi.onFinishHydration(() => {
      unsubscribe();
      resolve();
    });
  });
}
