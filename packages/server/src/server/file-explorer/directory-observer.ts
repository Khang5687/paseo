import { watch, type FSWatcher } from "node:fs";
import fs from "node:fs/promises";
import { resolveExplorerFilePath } from "./service.js";

interface DirectoryWatch {
  close(): void;
}

export interface DirectoryObserverDependencies {
  watchDirectory(
    directory: string,
    onChange: (eventType: string, filename: string | null) => void,
    onError: () => void,
  ): DirectoryWatch;
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
  setInterval(callback: () => void, delayMs: number): ReturnType<typeof setInterval>;
  clearInterval(handle: ReturnType<typeof setInterval>): void;
}

interface ObservedDirectory {
  listeners: Set<() => void>;
  fingerprint: string;
  watcher: DirectoryWatch | null;
  settle: ReturnType<typeof setTimeout> | null;
  fallback: ReturnType<typeof setInterval> | null;
  checks: Promise<void>;
}

export interface DirectorySubscription {
  /** Synchronous: no listener call can follow it. */
  unsubscribe(): void;
}

/** Bursts of renames (an `npm install`, a build writing many files) collapse into one check. */
const SETTLE_MS = 100;
/** Watcher unavailable or folder gone: poll until it can be watched again. */
const POLL_MS = 5_000;

const nodeDependencies: DirectoryObserverDependencies = {
  watchDirectory(directory, onChange, onError) {
    const watcher: FSWatcher = watch(directory, (eventType, filename) => {
      onChange(eventType, filename === null ? null : filename.toString());
    });
    watcher.on("error", onError);
    return watcher;
  },
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
};

/**
 * Watches the entry names of single directories for the Files tree. One non-recursive
 * watcher per resolved directory, shared by every subscriber. Listeners fire only when the
 * set of names or kinds changes; content writes to a file inside never notify, so a log
 * being appended does not re-list its folder.
 */
export class DirectoryObserver {
  private readonly dependencies: DirectoryObserverDependencies;
  private readonly observed = new Map<string, ObservedDirectory>();

  constructor(dependencies: DirectoryObserverDependencies = nodeDependencies) {
    this.dependencies = dependencies;
  }

  /** Directories with at least one subscriber. */
  get size(): number {
    return this.observed.size;
  }

  async subscribe(
    input: { cwd: string; path: string },
    listener: () => void,
  ): Promise<DirectorySubscription> {
    const target = await resolveExplorerFilePath({ root: input.cwd, relativePath: input.path });
    let observed = this.observed.get(target);
    if (!observed) {
      const initial = await readFingerprint(target);
      if (initial === MISSING) throw new Error("Directory not found");
      if (initial === NOT_DIRECTORY) throw new Error("Requested path is not a directory");
      observed = this.observed.get(target);
      if (!observed) {
        observed = {
          listeners: new Set(),
          fingerprint: initial,
          watcher: null,
          settle: null,
          fallback: null,
          checks: Promise.resolve(),
        };
        this.observed.set(target, observed);
        this.startWatching(target, observed);
      }
    }
    // Each subscriber gets its own function identity, so two subscriptions that share a
    // callback still release independently.
    const subscriber = () => listener();
    observed.listeners.add(subscriber);

    let active = true;
    return {
      unsubscribe: () => {
        if (!active) return;
        active = false;
        observed.listeners.delete(subscriber);
        if (observed.listeners.size === 0 && this.observed.get(target) === observed) {
          this.stopWatching(observed);
          this.observed.delete(target);
        }
      },
    };
  }

  dispose(): void {
    for (const observed of this.observed.values()) this.stopWatching(observed);
    this.observed.clear();
  }

  private startWatching(target: string, observed: ObservedDirectory): void {
    try {
      observed.watcher = this.dependencies.watchDirectory(
        target,
        (eventType, filename) => {
          // "rename" is every create, delete and move; "change" is a content write.
          if (eventType === "change" && filename !== null) return;
          this.scheduleCheck(target, observed);
        },
        () => this.usePolling(target, observed),
      );
    } catch {
      this.usePolling(target, observed);
    }
  }

  private usePolling(target: string, observed: ObservedDirectory): void {
    observed.watcher?.close();
    observed.watcher = null;
    if (observed.fallback) return;
    observed.fallback = this.dependencies.setInterval(
      () => this.enqueueCheck(target, observed),
      POLL_MS,
    );
  }

  private scheduleCheck(target: string, observed: ObservedDirectory): void {
    // Leading-edge window, not a trailing debounce: a folder that keeps changing still
    // reports every SETTLE_MS instead of never.
    if (observed.settle) return;
    observed.settle = this.dependencies.setTimeout(() => {
      observed.settle = null;
      this.enqueueCheck(target, observed);
    }, SETTLE_MS);
  }

  private enqueueCheck(target: string, observed: ObservedDirectory): void {
    observed.checks = observed.checks.then(() => this.check(target, observed));
  }

  /** Test hook: resolves once every queued check has finished. */
  async settled(): Promise<void> {
    await Promise.all([...this.observed.values()].map((observed) => observed.checks));
  }

  private async check(target: string, observed: ObservedDirectory): Promise<void> {
    if (this.observed.get(target) !== observed) return;
    const next = await readFingerprint(target);
    if (this.observed.get(target) !== observed) return;
    if (next === MISSING || next === NOT_DIRECTORY) {
      // The watched inode is gone; a recreated folder needs a new watcher.
      this.usePolling(target, observed);
    } else if (!observed.watcher && observed.fallback) {
      this.dependencies.clearInterval(observed.fallback);
      observed.fallback = null;
      this.startWatching(target, observed);
    }
    if (next === observed.fingerprint) return;
    observed.fingerprint = next;
    // A listener that unsubscribes another during this loop removes it before its turn.
    for (const listener of observed.listeners) listener();
  }

  private stopWatching(observed: ObservedDirectory): void {
    observed.watcher?.close();
    if (observed.settle) this.dependencies.clearTimeout(observed.settle);
    if (observed.fallback) this.dependencies.clearInterval(observed.fallback);
    observed.watcher = null;
    observed.settle = null;
    observed.fallback = null;
  }
}

const MISSING = "missing";
const NOT_DIRECTORY = "not-directory";

async function readFingerprint(directory: string): Promise<string> {
  try {
    const dirents = await fs.readdir(directory, { withFileTypes: true });
    return dirents
      .map((dirent) => `${dirent.isDirectory() ? "d" : "f"}:${dirent.name}`)
      .sort()
      .join("\0");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") return MISSING;
    if (code === "ENOTDIR") return NOT_DIRECTORY;
    return `error:${code ?? "unknown"}`;
  }
}

export const workspaceDirectoryObserver = new DirectoryObserver();
