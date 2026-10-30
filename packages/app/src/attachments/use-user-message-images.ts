import { useEffect } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { UserMessageImageRef } from "@getpaseo/protocol/agent-types";
import { createAssistantImageAcquisitionCache } from "@/assistant-image/acquisition-cache";
import { retainAttachmentForGarbageCollection } from "@/attachments/gc-retention";
import { persistAttachmentFromDataUrl } from "@/attachments/service";
import type { AttachmentMetadata } from "@/attachments/types";
import { createPreviewAttachmentId } from "@/attachments/utils";
import { useFetchQueries } from "@/data/query";
import { useSessionStore } from "@/stores/session-store";

// Bytes fetched once per image, persisted to the attachment store, and retained while shown.
const acquisitions = createAssistantImageAcquisitionCache<AttachmentMetadata>({
  capacity: 200,
  onRetain: (attachment) => retainAttachmentForGarbageCollection(attachment.id),
});

const NO_ATTACHMENTS: AttachmentMetadata[] = [];

/**
 * The images a user message shows. Local copies and daemon references are the same images, so
 * the sender shows its own copies; other clients resolve the references, in order, as they arrive.
 */
export function useUserMessageImages(input: {
  client?: Pick<DaemonClient, "getAgentTimelineImage"> | null;
  serverId?: string;
  agentId?: string;
  localImages?: AttachmentMetadata[];
  imageRefs?: readonly UserMessageImageRef[];
}): AttachmentMetadata[] {
  const { client, serverId, agentId, localImages = NO_ATTACHMENTS } = input;
  const imageRefs = localImages.length > 0 ? [] : (input.imageRefs ?? []);
  const supported = useSessionStore((state) =>
    serverId ? state.sessions[serverId]?.serverInfo?.features?.userMessageImages === true : false,
  );
  const keys = imageRefs.map((ref) => `${serverId ?? ""}:${agentId ?? ""}:${ref.id}`);
  const results = useFetchQueries(
    imageRefs.map((ref, index) => ({
      queryKey: ["userMessageImage", keys[index]],
      enabled: supported && Boolean(client) && Boolean(agentId),
      immutableWhen: () => true,
      dataShape: "value" as const,
      gcTime: 0,
      queryFn: () =>
        acquisitions.acquire(keys[index]!, async () => {
          const data = await client!.getAgentTimelineImage(agentId!, ref.id);
          if (data === null) throw new Error("Image unavailable");
          return await persistAttachmentFromDataUrl({
            id: createPreviewAttachmentId({
              mimeType: ref.mimeType,
              size: ref.size,
              contentKey: ref.id,
            }),
            dataUrl: `data:${ref.mimeType};base64,${data}`,
            mimeType: ref.mimeType,
          });
        }),
    })),
  );
  const attachments = results.map((result) => result.data);
  const retainedKey = attachments.map((attachment) => attachment?.id ?? "").join("\n");
  useEffect(() => {
    const releases = attachments.flatMap((attachment, index) =>
      attachment
        ? [acquisitions.acquireRetained(keys[index]!, async () => attachment).release]
        : [],
    );
    return () => releases.forEach((release) => release());
    // Retention follows which attachments resolved, not array identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retainedKey]);
  if (localImages.length > 0) return localImages;
  return attachments.flatMap((attachment) => (attachment ? [attachment] : []));
}
