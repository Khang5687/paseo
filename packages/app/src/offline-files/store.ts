import { useSyncExternalStore } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { z } from "zod";
import { retainAttachmentForGarbageCollection } from "@/attachments/gc-retention";
import {
  deleteAttachments,
  persistAttachmentFromBytes,
  readAttachmentBytes,
} from "@/attachments/service";
import type { AttachmentMetadata } from "@/attachments/types";
import { getFileNameFromPath } from "@/attachments/utils";

const INDEX_KEY = "@paseo:offline-files";
const DAY_MS = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;

const OfflineFileSchema = z.object({
  serverId: z.string(),
  /** Absolute path on the host. */
  path: z.string(),
  size: z.number(),
  modifiedAt: z.string(),
  revision: z.string().optional(),
  kind: z.enum(["text", "image", "binary"]),
  mimeType: z.string(),
  /** When the copy was last downloaded or confirmed to match the host. */
  savedAt: z.number(),
  attachment: z.looseObject({
    id: z.string(),
    mimeType: z.string(),
    storageType: z.string(),
    storageKey: z.string(),
    createdAt: z.number(),
  }),
});

/** A file copied from a host so it opens while the host is offline. */
export type OfflineFile = Omit<z.infer<typeof OfflineFileSchema>, "attachment"> & {
  attachment: AttachmentMetadata;
};

export interface OfflineFileLimits {
  offlineFilesRetentionDays: number;
  offlineFilesMaxTotalMb: number;
}

export interface OfflineFileVersion {
  size: number;
  modifiedAt: string;
  revision?: string;
}

let entries: OfflineFile[] | null = null;
let loading: Promise<OfflineFile[]> | null = null;
let tail: Promise<unknown> = Promise.resolve();
const listeners = new Set<() => void>();

function load(): Promise<OfflineFile[]> {
  if (entries) return Promise.resolve(entries);
  loading ??= AsyncStorage.getItem(INDEX_KEY)
    .then((raw) => {
      const parsed = z.array(OfflineFileSchema).safeParse(raw ? JSON.parse(raw) : []);
      entries ??= parsed.success ? (parsed.data as OfflineFile[]) : [];
      return entries;
    })
    .catch(() => {
      entries ??= [];
      return entries;
    });
  return loading;
}

/** Runs index changes one at a time, so a slow save cannot overwrite a newer one. */
function mutate<T>(
  change: (current: OfflineFile[]) => Promise<{ next: OfflineFile[]; result: T }>,
) {
  const run = (async () => {
    await tail;
    const { next, result } = await change(await load());
    entries = next;
    await AsyncStorage.setItem(INDEX_KEY, JSON.stringify(next));
    for (const listener of listeners) listener();
    return result;
  })();
  tail = run.catch(() => undefined);
  return run;
}

function sameFile(entry: OfflineFile, serverId: string, path: string): boolean {
  return entry.serverId === serverId && entry.path === path;
}

export function isSameOfflineVersion(a: OfflineFileVersion, b: OfflineFileVersion): boolean {
  if (a.revision && b.revision) return a.revision === b.revision;
  return a.size === b.size && a.modifiedAt === b.modifiedAt;
}

/**
 * Splits saved files into the ones to keep and the ones to delete: anything older than the
 * retention window goes, then the oldest go until the rest fit the total cap.
 */
export function selectOfflineEvictions(
  current: readonly OfflineFile[],
  limits: OfflineFileLimits,
  now: number,
): { keep: OfflineFile[]; evict: OfflineFile[] } {
  const cutoff = now - limits.offlineFilesRetentionDays * DAY_MS;
  const newestFirst = [...current].sort((a, b) => b.savedAt - a.savedAt);
  const keep: OfflineFile[] = [];
  const evict: OfflineFile[] = [];
  let total = 0;
  for (const entry of newestFirst) {
    if (entry.savedAt < cutoff || total + entry.size > limits.offlineFilesMaxTotalMb * MB) {
      evict.push(entry);
      continue;
    }
    total += entry.size;
    keep.push(entry);
  }
  return { keep, evict };
}

export function getOfflineFile(serverId: string, path: string): Promise<OfflineFile | null> {
  return load().then((all) => all.find((entry) => sameFile(entry, serverId, path)) ?? null);
}

export function saveOfflineFile(input: {
  serverId: string;
  path: string;
  version: OfflineFileVersion & { kind: OfflineFile["kind"]; mimeType: string };
  bytes: Uint8Array;
  limits: OfflineFileLimits;
}): Promise<OfflineFile> {
  // The collector keeps ids in the index; hold the new one until the index has it.
  let release = () => {};
  return mutate(async (current) => {
    const attachment = await persistAttachmentFromBytes({
      bytes: input.bytes,
      mimeType: input.version.mimeType,
      fileName: getFileNameFromPath(input.path),
    });
    release = retainAttachmentForGarbageCollection(attachment.id);
    const saved: OfflineFile = {
      serverId: input.serverId,
      path: input.path,
      size: input.bytes.byteLength,
      modifiedAt: input.version.modifiedAt,
      revision: input.version.revision,
      kind: input.version.kind,
      mimeType: input.version.mimeType,
      savedAt: Date.now(),
      attachment,
    };
    const replaced = current.filter((entry) => sameFile(entry, input.serverId, input.path));
    const others = current.filter((entry) => !sameFile(entry, input.serverId, input.path));
    const { keep, evict } = selectOfflineEvictions([saved, ...others], input.limits, Date.now());
    await deleteAttachments([...replaced, ...evict].map((entry) => entry.attachment));
    return { next: keep, result: saved };
  }).finally(() => release());
}

/** Records that the saved copy still matches the host. */
export function touchOfflineFile(serverId: string, path: string): Promise<void> {
  return mutate(async (current) => ({
    next: current.map((entry) =>
      sameFile(entry, serverId, path) ? { ...entry, savedAt: Date.now() } : entry,
    ),
    result: undefined,
  }));
}

export function pruneOfflineFiles(limits: OfflineFileLimits): Promise<void> {
  return mutate(async (current) => {
    const { keep, evict } = selectOfflineEvictions(current, limits, Date.now());
    if (evict.length > 0) await deleteAttachments(evict.map((entry) => entry.attachment));
    return { next: keep, result: undefined };
  });
}

export function clearOfflineFiles(): Promise<void> {
  return mutate(async (current) => {
    await deleteAttachments(current.map((entry) => entry.attachment));
    return { next: [], result: undefined };
  });
}

export function readOfflineFileBytes(entry: OfflineFile): Promise<Uint8Array> {
  return readAttachmentBytes(entry.attachment);
}

/** Attachment ids the attachment garbage collector must keep. */
export async function listOfflineFileAttachmentIds(): Promise<string[]> {
  return (await load()).map((entry) => entry.attachment.id);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!entries) void load().then(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = () => entries;

/** Every saved file, or null while the index loads. */
export function useOfflineFiles(): readonly OfflineFile[] | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
