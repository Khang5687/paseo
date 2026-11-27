import { useEffect, useMemo } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { UserMessageAttachmentFile } from "@getpaseo/protocol/agent-types";
import { createAssistantImageAcquisitionCache } from "@/assistant-image/acquisition-cache";
import { retainAttachmentForGarbageCollection } from "@/attachments/gc-retention";
import { persistAttachmentFromBytes } from "@/attachments/service";
import type { AttachmentMetadata } from "@/attachments/types";
import { createPreviewAttachmentId, getFileNameFromPath } from "@/attachments/utils";
import { useFetchQueries } from "@/data/query";
import { resolveFilePreviewReadTarget } from "@/file-explorer/preview-target";

/**
 * A user message's pictures, read back from the files the host saved when it was sent. Any
 * client can do this, after a reload or a daemon restart, because the timeline names the files.
 * Each copy is persisted like a markdown image and kept from attachment GC while it is shown.
 */
const hostImageCopies = createAssistantImageAcquisitionCache<AttachmentMetadata>({
  capacity: 200,
  onRetain: (attachment) => retainAttachmentForGarbageCollection(attachment.id),
});

const NO_FILES: UserMessageAttachmentFile[] = [];

/**
 * What a user message shows: its local copies when this client has them (the sender), else the
 * pictures the host saved for it; file pills only when the row has no local attachments; and the
 * image each `[Image #N]` label names.
 */
export function useUserMessageFiles(input: {
  serverId?: string;
  client?: Pick<DaemonClient, "readFile"> | null;
  localImages: readonly AttachmentMetadata[];
  hasLocalAttachments: boolean;
  attachmentFiles: readonly UserMessageAttachmentFile[] | undefined;
}): {
  images: AttachmentMetadata[];
  imagesByLabel: ReadonlyMap<string, AttachmentMetadata>;
  hostFiles: readonly UserMessageAttachmentFile[];
} {
  const { localImages, attachmentFiles } = input;
  const { imageFiles, otherFiles } = useMemo(() => {
    const pictures: UserMessageAttachmentFile[] = [];
    const others: UserMessageAttachmentFile[] = [];
    for (const file of attachmentFiles ?? NO_FILES) {
      (file.label.startsWith("Image ") ? pictures : others).push(file);
    }
    return { imageFiles: pictures, otherFiles: others };
  }, [attachmentFiles]);
  const hasLocalImages = localImages.length > 0;
  const hostImages = useHostMessageImages({
    serverId: input.serverId,
    client: input.client,
    files: hasLocalImages ? NO_FILES : imageFiles,
  });
  const shown: ReadonlyArray<AttachmentMetadata | null> = hasLocalImages ? localImages : hostImages;
  const images = useMemo(
    () => shown.filter((image): image is AttachmentMetadata => image !== null),
    [shown],
  );
  // Images and their labels are both in send order, so the Nth image has the Nth image label.
  const imagesByLabel = useMemo(() => {
    const byLabel = new Map<string, AttachmentMetadata>();
    if (shown.length !== imageFiles.length) return byLabel;
    imageFiles.forEach((file, index) => {
      const image = shown[index];
      if (image) byLabel.set(file.label, image);
    });
    return byLabel;
  }, [imageFiles, shown]);
  return { images, imagesByLabel, hostFiles: input.hasLocalAttachments ? NO_FILES : otherFiles };
}

/** One entry per file, in order: its local copy once read, or null while loading or missing. */
function useHostMessageImages(input: {
  serverId?: string;
  client?: Pick<DaemonClient, "readFile"> | null;
  files: readonly UserMessageAttachmentFile[];
}): Array<AttachmentMetadata | null> {
  const { serverId, client, files } = input;
  const reads = useMemo(
    () =>
      files.map((file) => {
        const key = `host-message-image:${serverId ?? "unknown-server"}:${file.path}`;
        const target = resolveFilePreviewReadTarget({ path: file.path });
        const locate = async (): Promise<AttachmentMetadata> => {
          if (!client || !target) throw new Error("Image unavailable");
          const read = await client.readFile(target.cwd, target.path);
          if (read.kind !== "image") throw new Error("Image unavailable");
          return await persistAttachmentFromBytes({
            id: createPreviewAttachmentId({
              mimeType: read.mime,
              path: read.path || file.path,
              size: read.size,
              modifiedAt: read.modifiedAt,
              contentLength: read.bytes.byteLength,
              contentKey: serverId ?? null,
            }),
            bytes: read.bytes,
            mimeType: read.mime,
            fileName: getFileNameFromPath(file.path),
          });
        };
        return { key, locate };
      }),
    [client, files, serverId],
  );
  const results = useFetchQueries(
    reads.map((read) => ({
      queryKey: ["hostMessageImage", read.key],
      // The key holds no client, so wait for one: a read that failed without it would not rerun.
      enabled: client != null,
      immutableWhen: () => true,
      dataShape: "value",
      gcTime: 0,
      queryFn: () => hostImageCopies.acquire(read.key, read.locate),
    })),
  );
  useEffect(() => {
    const releases = results.flatMap((result, index) => {
      const read = reads[index];
      if (!result.data || !read) return [];
      const value = result.data;
      return [hostImageCopies.acquireRetained(read.key, async () => value).release];
    });
    return () => releases.forEach((release) => release());
  }, [results, reads]);
  return results.map((result) => result.data ?? null);
}
