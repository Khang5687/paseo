import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type pino from "pino";
import { z } from "zod";
import {
  FileCopyEntrySchema,
  type FileCopyEntry,
  type FileCopyUsage,
} from "@getpaseo/protocol/file-copies/schemas";
import { writeFileAtomic } from "../atomic-file.js";

export interface FileCopyLimits {
  keepDays: number;
  maxTotalBytes: number;
  maxFileBytes: number;
}

// Owner decision Q58: keep 30 days after the last mention, 5 GB in total, 64 MB per file.
export const DEFAULT_FILE_COPY_LIMITS: FileCopyLimits = {
  keepDays: 30,
  maxTotalBytes: 5 * 1024 ** 3,
  maxFileBytes: 64 * 1024 ** 2,
};

const DAY_MS = 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

const StoredFileCopySchema = FileCopyEntrySchema.extend({ blob: z.string() });
type StoredFileCopy = z.infer<typeof StoredFileCopySchema>;

const ManifestSchema = z.object({
  version: z.literal(1),
  // The last home directory each source host reported, for `~/…` reads.
  homes: z.record(z.string(), z.string()),
  entries: z.array(StoredFileCopySchema),
});

export interface PutFileCopyInput {
  sourceServerId: string;
  sourceHome: string;
  path: string;
  size: number;
  mimeType: string;
  modifiedAt: string;
  revision: string;
  /** A file on this host holding the bytes; the store moves it into place. */
  file: string;
}

export interface FileCopyStoreOptions {
  paseoHome: string;
  logger: pino.Logger;
  limits?: FileCopyLimits;
  now?: () => Date;
}

/**
 * Copies of files that agents on other hosts mentioned, under `$PASEO_HOME/file-copies/`:
 * `manifest.json` lists them, `blobs/` holds the bytes. Every change runs on one queue and
 * rewrites the manifest atomically; a blob is never rewritten in place, so a read that opened
 * it keeps its bytes while a newer copy replaces it.
 */
export class FileCopyStore {
  private readonly root: string;
  private readonly blobsDir: string;
  private readonly manifestPath: string;
  private readonly logger: pino.Logger;
  private readonly now: () => Date;
  private limits: FileCopyLimits;
  private entries = new Map<string, StoredFileCopy>();
  private homes = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();
  private pruneTimer: NodeJS.Timeout | undefined;

  constructor(options: FileCopyStoreOptions) {
    this.root = path.join(options.paseoHome, "file-copies");
    this.blobsDir = path.join(this.root, "blobs");
    this.manifestPath = path.join(this.root, "manifest.json");
    this.logger = options.logger.child({ module: "file-copies" });
    this.limits = options.limits ?? DEFAULT_FILE_COPY_LIMITS;
    this.now = options.now ?? (() => new Date());
  }

  async start(): Promise<void> {
    await this.enqueue(async () => {
      await fs.mkdir(this.blobsDir, { recursive: true });
      await this.load();
      await this.removeUnlistedBlobs();
      await this.pruneAndSave();
    });
    this.pruneTimer = setInterval(() => {
      void this.enqueue(() => this.pruneAndSave()).catch((err: unknown) =>
        this.logger.warn({ err }, "Failed to prune file copies"),
      );
    }, PRUNE_INTERVAL_MS);
    this.pruneTimer.unref?.();
  }

  async stop(): Promise<void> {
    clearInterval(this.pruneTimer);
    this.pruneTimer = undefined;
    await this.queue.catch(() => undefined);
  }

  getLimits(): FileCopyLimits {
    return this.limits;
  }

  setLimits(limits: FileCopyLimits): Promise<void> {
    return this.enqueue(async () => {
      this.limits = limits;
      await this.pruneAndSave();
    });
  }

  usage(): FileCopyUsage {
    let totalBytes = 0;
    for (const entry of this.entries.values()) totalBytes += entry.size;
    return { totalBytes, fileCount: this.entries.size };
  }

  /**
   * Marks the files a source turn mentioned. A copy at the same revision counts as mentioned
   * again; the paths returned have no copy at that revision and need an upload.
   */
  recordMentions(
    sourceServerId: string,
    sourceHome: string,
    files: readonly { path: string; revision: string }[],
  ): Promise<string[]> {
    return this.enqueue(async () => {
      this.homes.set(sourceServerId, sourceHome);
      const now = this.now().toISOString();
      const needed: string[] = [];
      for (const file of files) {
        const entry = this.entries.get(entryKey(sourceServerId, file.path));
        if (entry?.revision === file.revision) {
          entry.lastMentionedAt = now;
        } else if (!needed.includes(file.path)) {
          needed.push(file.path);
        }
      }
      await this.save();
      return needed;
    });
  }

  put(input: PutFileCopyInput): Promise<FileCopyEntry> {
    return this.enqueue(async () => {
      if (!path.isAbsolute(input.path) && !/^[A-Za-z]:[\\/]/.test(input.path)) {
        throw new Error("A copy needs the file's absolute path on its host");
      }
      if (input.size > this.limits.maxFileBytes || input.size > this.limits.maxTotalBytes) {
        throw new Error(`File is larger than the ${this.limits.maxFileBytes}-byte copy limit`);
      }
      const stats = await fs.stat(input.file);
      if (!stats.isFile() || stats.size !== input.size) {
        throw new Error(`Copy size mismatch: expected ${input.size}, found ${stats.size}`);
      }
      const key = entryKey(input.sourceServerId, input.path);
      const blob = `${key}-${randomUUID()}`;
      await fs.rename(input.file, path.join(this.blobsDir, blob));
      const previous = this.entries.get(key);
      const now = this.now().toISOString();
      const entry: StoredFileCopy = {
        sourceServerId: input.sourceServerId,
        path: input.path,
        size: input.size,
        mimeType: input.mimeType,
        modifiedAt: input.modifiedAt,
        revision: input.revision,
        savedAt: now,
        lastMentionedAt: now,
        blob,
      };
      this.homes.set(input.sourceServerId, input.sourceHome);
      this.entries.delete(key);
      this.entries.set(key, entry);
      await this.pruneAndSave();
      if (previous) await this.removeBlob(previous.blob);
      return toPublicEntry(entry);
    });
  }

  /** The copy of `filePath` (absolute, or `~/…` against the source's home), if one is kept. */
  resolve(
    sourceServerId: string,
    filePath: string,
  ): { entry: FileCopyEntry; blobPath: string } | null {
    const absolutePath = this.expandHome(sourceServerId, filePath);
    if (!absolutePath) return null;
    const entry = this.entries.get(entryKey(sourceServerId, absolutePath));
    if (!entry || this.isExpired(entry, this.now().getTime())) return null;
    return { entry: toPublicEntry(entry), blobPath: path.join(this.blobsDir, entry.blob) };
  }

  list(options: { sourceServerId?: string; query?: string; limit?: number } = {}): FileCopyEntry[] {
    const query = options.query?.trim().toLowerCase();
    const entries = [...this.entries.values()]
      .filter(
        (entry) =>
          (!options.sourceServerId || entry.sourceServerId === options.sourceServerId) &&
          (!query || entry.path.toLowerCase().includes(query)),
      )
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    return (options.limit ? entries.slice(0, options.limit) : entries).map(toPublicEntry);
  }

  remove(sourceServerId: string, filePath: string): Promise<boolean> {
    return this.enqueue(async () => {
      const absolutePath = this.expandHome(sourceServerId, filePath);
      const key = absolutePath ? entryKey(sourceServerId, absolutePath) : null;
      const entry = key ? this.entries.get(key) : undefined;
      if (!key || !entry) return false;
      this.entries.delete(key);
      await this.save();
      await this.removeBlob(entry.blob);
      return true;
    });
  }

  private expandHome(sourceServerId: string, filePath: string): string | null {
    if (filePath !== "~" && !filePath.startsWith("~/")) return filePath;
    const home = this.homes.get(sourceServerId);
    if (!home) return null;
    return filePath === "~" ? home : `${home.replace(/[\\/]+$/, "")}/${filePath.slice(2)}`;
  }

  private isExpired(entry: StoredFileCopy, nowMs: number): boolean {
    return Date.parse(entry.lastMentionedAt) + this.limits.keepDays * DAY_MS <= nowMs;
  }

  /** Expired copies go first, then the least recently mentioned until the total fits. */
  private async pruneAndSave(): Promise<void> {
    const nowMs = this.now().getTime();
    const evicted: StoredFileCopy[] = [];
    for (const [key, entry] of this.entries) {
      if (this.isExpired(entry, nowMs) || entry.size > this.limits.maxFileBytes) {
        this.entries.delete(key);
        evicted.push(entry);
      }
    }
    let totalBytes = this.usage().totalBytes;
    if (totalBytes > this.limits.maxTotalBytes) {
      const oldestFirst = [...this.entries].sort(([, a], [, b]) =>
        a.lastMentionedAt === b.lastMentionedAt
          ? a.savedAt.localeCompare(b.savedAt)
          : a.lastMentionedAt.localeCompare(b.lastMentionedAt),
      );
      for (const [key, entry] of oldestFirst) {
        if (totalBytes <= this.limits.maxTotalBytes) break;
        this.entries.delete(key);
        evicted.push(entry);
        totalBytes -= entry.size;
      }
    }
    await this.save();
    for (const entry of evicted) await this.removeBlob(entry.blob);
    if (evicted.length > 0) {
      this.logger.info({ evicted: evicted.length, totalBytes }, "Removed old file copies");
    }
  }

  private async save(): Promise<void> {
    const manifest = {
      version: 1 as const,
      homes: Object.fromEntries(this.homes),
      entries: [...this.entries.values()],
    };
    await writeFileAtomic(this.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  private async load(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.manifestPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    let parsed: z.infer<typeof ManifestSchema>;
    try {
      parsed = ManifestSchema.parse(JSON.parse(raw));
    } catch (err) {
      this.logger.warn({ err, manifestPath: this.manifestPath }, "Ignoring unreadable copy list");
      return;
    }
    this.homes = new Map(Object.entries(parsed.homes));
    this.entries = new Map(
      parsed.entries.map((entry) => [entryKey(entry.sourceServerId, entry.path), entry]),
    );
  }

  /** Drops blobs no entry lists (a crash between move and save) and entries without a blob. */
  private async removeUnlistedBlobs(): Promise<void> {
    const listed = new Set([...this.entries.values()].map((entry) => entry.blob));
    const present = new Set(await fs.readdir(this.blobsDir));
    for (const name of present) {
      if (!listed.has(name)) await this.removeBlob(name);
    }
    for (const [key, entry] of this.entries) {
      if (!present.has(entry.blob)) this.entries.delete(key);
    }
  }

  private async removeBlob(blob: string): Promise<void> {
    await fs.rm(path.join(this.blobsDir, blob), { force: true });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }
}

function entryKey(sourceServerId: string, filePath: string): string {
  return createHash("sha256").update(`${sourceServerId}\0${filePath}`).digest("hex");
}

function toPublicEntry({ blob: _blob, ...entry }: StoredFileCopy): FileCopyEntry {
  return entry;
}
