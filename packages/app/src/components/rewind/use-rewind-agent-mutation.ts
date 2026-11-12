import { planTimelineTailFetch } from "@/timeline/timeline-sync-plan";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import { useToast } from "@/contexts/toast-context";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { RewindMode } from "./use-rewind-capabilities";
import { useRewindComposerRestore } from "./composer-restore";
import { useSessionStore } from "@/stores/session-store";
import { shouldRestoreComposerForRewindMode } from "./rewind-mode";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import type { AttachmentMetadata } from "@/attachments/types";
import { useSentMessageImagesStore } from "@/stores/sent-message-images-store";

interface UseRewindAgentMutationInput {
  serverId?: string;
  agentId?: string;
  messageId?: string;
  clientMessageId?: string;
  client?: DaemonClient | null;
}

interface RewindAgentInput {
  mode: RewindMode;
  rewoundText: string;
  rewoundImages?: AttachmentMetadata[];
}

export function useRewindAgentMutation(input: UseRewindAgentMutationInput): {
  rewindAgent: (input: RewindAgentInput) => Promise<void>;
  isPending: boolean;
} {
  const toast = useToast();
  const { t } = useTranslation();
  const composerRestore = useRewindComposerRestore();
  const { isPending, mutateAsync } = useMutation({
    mutationFn: async ({ mode }: RewindAgentInput) => {
      if (!input.client || !input.agentId || !input.messageId) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      await input.client.rewindAgent(input.agentId, input.messageId, mode);
      if (mode !== "files") {
        const cursor = input.serverId
          ? useSessionStore
              .getState()
              .sessions[input.serverId]?.agentTimelineCursor.get(input.agentId)
          : undefined;
        if (!input.serverId) throw new Error(t("common.errors.daemonClientUnavailable"));
        await getHostRuntimeStore().fetchAgentTimeline(input.serverId, input.agentId, {
          ...planTimelineTailFetch(),
          ...(cursor ? { cursor: { epoch: cursor.epoch, seq: cursor.endSeq } } : {}),
        });
      }
    },
    onSuccess: (_data, variables) => {
      if (!shouldRestoreComposerForRewindMode(variables.mode)) {
        return;
      }
      if (!composerRestore) return;
      composerRestore.completeRewind(variables.rewoundText, variables.rewoundImages ?? []);
      // The composer draft owns the images now; drop the sent-message entry so GC can free
      // them if the draft is discarded.
      if (input.serverId && input.agentId) {
        const store = useSentMessageImagesStore.getState();
        for (const messageId of [input.messageId, input.clientMessageId]) {
          if (!messageId) continue;
          store.remove({ serverId: input.serverId, agentId: input.agentId, messageId });
        }
      }
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : t("rewind.errors.failed"));
    },
  });

  const rewindAgent = useCallback(
    async (rewindInput: RewindAgentInput) => {
      if (isPending) {
        return;
      }
      await mutateAsync(rewindInput);
    },
    [isPending, mutateAsync],
  );

  return {
    rewindAgent,
    isPending,
  };
}
