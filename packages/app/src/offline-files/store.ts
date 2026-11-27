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
  /**
   * Saved on purpose (Save offline, Download, Send to), not only opened: age never removes it.
   * Missing on copies saved before pinning existed.
   */
  pinned: z.boolean().optional(),
  /** Another device sent it here (Send to). Missing on copies saved before this was recorded. */
  sent: z.boolean().optional(),
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
 * Splits saved files into the ones to keep and the ones to delete: unpinned files older than the
 * retention window go, then the oldest go until the rest fit the total cap. Pinned files fill the
 * cap first, so a file the user saved on purpose goes only after every file kept on open.
 */
export function selectOfflineEvictions(
  current: readonly OfflineFile[],
  limits: OfflineFileLimits,
  now: number,
): { keep: OfflineFile[]; evict: OfflineFile[] } {
  const cutoff = now - limits.offlineFilesRetentionDays * DAY_MS;
  const byPriority = [...current].sort(
    (a, b) => Number(b.pinned === true) - Number(a.pinned === true) || b.savedAt - a.savedAt,
  );
  const keep: OfflineFile[] = [];
  const evict: OfflineFile[] = [];
  let total = 0;
  for (const entry of byPriority) {
    const aged = !entry.pinned && entry.savedAt < cutoff;
    if (aged || total + entry.size > limits.offlineFilesMaxTotalMb * MB) {
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

/**
 * Saved files of one host under `cwd` whose path ends with `query`, newest first, relative to
 * `cwd`. Answers the bare-name lookups chat links make while the host is offline. With no saved
 * match it returns the name as written, since the offline host cannot search; the file pane then
 * looks for another host's copy of it.
 */
export function matchOfflineFiles(
  current: readonly OfflineFile[],
  input: { serverId: string; cwd: string; query: string },
): string[] {
  const prefix = `${input.cwd.replace(/[\\/]+$/, "")}/`;
  const query = input.query.replace(/^[\\/]+/, "");
  const matches = current
    .filter((entry) => entry.serverId === input.serverId && entry.path.startsWith(prefix))
    .sort((a, b) => b.savedAt - a.savedAt)
    .map((entry) => entry.path.slice(prefix.length))
    .filter((relative) => relative === query || relative.endsWith(`/${query}`));
  return matches.length > 0 || !query ? matches : [query];
}

export async function findOfflineFiles(input: {
  serverId: string;
  cwd: string;
  query: string;
}): Promise<string[]> {
  return matchOfflineFiles(await load(), input);
}

interface SaveOfflineFileInput {
  serverId: string;
  path: string;
  version: OfflineFileVersion & { kind: OfflineFile["kind"]; mimeType: string };
  limits: OfflineFileLimits;
  /** Saved on purpose. A copy pinned once stays pinned when it is refreshed. */
  pinned?: boolean;
  /** Sent from another device. A copy marked once stays marked when it is refreshed. */
  sent?: boolean;
}

export function saveOfflineFile(
  input: SaveOfflineFileInput & { bytes: Uint8Array },
): Promise<OfflineFile> {
  return commitOfflineFile(input, input.bytes.byteLength, () =>
    persistAttachmentFromBytes({
      bytes: input.bytes,
      mimeType: input.version.mimeType,
      fileName: getFileNameFromPath(input.path),
    }),
  );
}

/**
 * Saves a copy whose bytes are already in the attachment store, written there in chunks. The
 * caller holds the attachment against garbage collection until this settles.
 */
export function saveOfflineAttachment(
  input: SaveOfflineFileInput & { attachment: AttachmentMetadata },
): Promise<OfflineFile> {
  return commitOfflineFile(
    input,
    input.attachment.byteSize ?? input.version.size,
    async () => input.attachment,
  );
}

function commitOfflineFile(
  input: SaveOfflineFileInput,
  size: number,
  getAttachment: () => Promise<AttachmentMetadata>,
): Promise<OfflineFile> {
  // The collector keeps ids in the index; hold the new one until the index has it.
  let release = () => {};
  return mutate(async (current) => {
    const attachment = await getAttachment();
    release = retainAttachmentForGarbageCollection(attachment.id);
    const replaced = current.filter((entry) => sameFile(entry, input.serverId, input.path));
    const others = current.filter((entry) => !sameFile(entry, input.serverId, input.path));
    const saved: OfflineFile = {
      serverId: input.serverId,
      path: input.path,
      size,
      modifiedAt: input.version.modifiedAt,
      revision: input.version.revision,
      kind: input.version.kind,
      mimeType: input.version.mimeType,
      savedAt: Date.now(),
      pinned: input.pinned === true || replaced.some((entry) => entry.pinned === true),
      sent: input.sent === true || replaced.some((entry) => entry.sent === true),
      attachment,
    };
    const { keep, evict } = selectOfflineEvictions([saved, ...others], input.limits, Date.now());
    await deleteAttachments([...replaced, ...evict].map((entry) => entry.attachment));
    return { next: keep, result: saved };
  }).finally(() => release());
}

/**
 * Records that the saved copy still matches the host, pins it when `pin` is set and marks it sent
 * when `sent` is set.
 */
export function touchOfflineFile(
  serverId: string,
  path: string,
  options: { pin?: boolean; sent?: boolean } = {},
): Promise<void> {
  return mutate(async (current) => ({
    next: current.map((entry) =>
      sameFile(entry, serverId, path)
        ? {
            ...entry,
            savedAt: Date.now(),
            pinned: entry.pinned === true || options.pin === true,
            sent: entry.sent === true || options.sent === true,
          }
        : entry,
    ),
    result: undefined,
  }));
}

/** A saved file's identity: its host and absolute path. */
export interface OfflineFileKey {
  serverId: string;
  path: string;
}

function inKeys(entry: OfflineFile, keys: readonly OfflineFileKey[]): boolean {
  return keys.some((key) => sameFile(entry, key.serverId, key.path));
}

/** Pins or unpins these saved files. An unpinned copy ages out like a file kept on open. */
export function setOfflineFilesPinned(
  keys: readonly OfflineFileKey[],
  pinned: boolean,
): Promise<void> {
  return mutate(async (current) => ({
    next: current.map((entry) => (inKeys(entry, keys) ? { ...entry, pinned } : entry)),
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

export function removeOfflineFiles(keys: readonly OfflineFileKey[]): Promise<void> {
  return mutate(async (current) => {
    const removed = current.filter((entry) => inKeys(entry, keys));
    if (removed.length > 0) await deleteAttachments(removed.map((entry) => entry.attachment));
    return { next: current.filter((entry) => !inKeys(entry, keys)), result: undefined };
  });
}

export function readOfflineFileBytes(entry: OfflineFile): Promise<Uint8Array> {
  return readAttachmentBytes(entry.attachment);
}

/** Attachment ids the attachment garbage collector must keep. */
export async function listOfflineFileAttachmentIds(): Promise<string[]> {
  return (await load()).map((entry) => entry.attachment.id);
}

/** Every saved file once the index has loaded; before that, null, and the load starts. */
export function peekOfflineFiles(): readonly OfflineFile[] | null {
  if (!entries) void load();
  return entries;
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
