import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentDraftSnapshotSummary } from "@getpaseo/protocol/messages";
import { base64ToUint8Array } from "@/attachments/selected-file";
import { encodeAttachmentsForSend, persistAttachmentFromBytes } from "@/attachments/service";
import { useAppVisible } from "@/hooks/use-app-visible";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useDraftStore } from "@/stores/draft-store";
import {
  AgentDraftSyncController,
  type AgentDraftSyncLocal,
  type AgentDraftSyncMedia,
} from "@/composer/draft/agent-draft-sync";

const EMPTY_HISTORY: AgentDraftSnapshotSummary[] = [];

const draftSyncMedia: AgentDraftSyncMedia = {
  readImageBytes: async (metadata) => {
    const [encoded] = (await encodeAttachmentsForSend([metadata])) ?? [];
    if (!encoded) throw new Error("Image bytes are missing.");
    return base64ToUint8Array(encoded.data);
  },
  saveImage: ({ base64, mimeType, fileName }) =>
    persistAttachmentFromBytes({ bytes: base64ToUint8Array(base64), mimeType, fileName }),
};

function createDraftStoreLocal(
  draftKey: string,
  showRemoteText: (text: string) => void,
): AgentDraftSyncLocal {
  const store = useDraftStore;
  return {
    read: () => {
      const record = store.getState().drafts[draftKey];
      if (!record) return null;
      return {
        input: record.input,
        lifecycle: record.lifecycle,
        version: record.version,
        updatedAt: record.updatedAt,
        synced: record.syncedVersion === record.version,
      };
    },
    subscribe: (listener) =>
      store.subscribe((state, previous) => {
        if (state.drafts[draftKey] !== previous.drafts[draftKey]) listener();
      }),
    apply: (input, updatedAt) => {
      store.getState().applySyncedDraftInput({ draftKey, draft: input, updatedAt });
      showRemoteText(input.text);
    },
    markSynced: (version) => store.getState().markDraftSynced({ draftKey, version }),
    setImageUploadId: (imageId, uploadId) => {
      const current = store.getState().getDraftInput(draftKey);
      if (!current) return;
      store.getState().saveDraftInput({
        draftKey,
        draft: {
          ...current,
          attachments: current.attachments.map((attachment) =>
            attachment.kind === "image" && attachment.metadata.id === imageId
              ? { kind: "image", metadata: { ...attachment.metadata, uploadId } }
              : attachment,
          ),
        },
      });
    },
  };
}

export interface AgentDraftSync {
  /** Earlier drafts this agent's composer lost, newest first. */
  history: AgentDraftSnapshotSummary[];
  restore: (snapshotId: string) => void;
}

/**
 * Syncs an agent chat draft with the daemon while `enabled` (the chat is on screen)
 * and the app is visible. Hosts without `agentDraftSync` keep the draft on the device.
 */
export function useAgentDraftSync(input: {
  serverId: string;
  agentId: string;
  draftKey: string;
  enabled: boolean;
  showRemoteText: (text: string) => void;
}): AgentDraftSync {
  const { serverId, agentId, draftKey, enabled, showRemoteText } = input;
  const client = useHostRuntimeClient(serverId);
  const isSupported = useHostFeature(serverId, "agentDraftSync");
  const isAppVisible = useAppVisible();
  const isActive = enabled && isSupported && isAppVisible && client !== null;
  const [history, setHistory] = useState<AgentDraftSnapshotSummary[]>(EMPTY_HISTORY);
  const controllerRef = useRef<AgentDraftSyncController | null>(null);
  const showRemoteTextRef = useRef(showRemoteText);
  showRemoteTextRef.current = showRemoteText;

  useEffect(() => {
    if (!isActive || !client) return;
    const controller = new AgentDraftSyncController({
      agentId,
      client,
      local: createDraftStoreLocal(draftKey, (text) => showRemoteTextRef.current(text)),
      media: draftSyncMedia,
      onHistory: setHistory,
    });
    controllerRef.current = controller;
    controller.start();
    return () => {
      controller.stop();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [agentId, client, draftKey, isActive]);

  const restore = useCallback((snapshotId: string) => {
    void controllerRef.current
      ?.restore(snapshotId)
      .catch((error) => console.warn("[DraftSync] Failed to restore draft", error));
  }, []);

  return { history: isSupported ? history : EMPTY_HISTORY, restore };
}
