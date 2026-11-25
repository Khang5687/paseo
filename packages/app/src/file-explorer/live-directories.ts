export interface LiveDirectoryWatch {
  unsubscribe(): Promise<void>;
}

export interface LiveExplorerDirectoriesOptions {
  /** Starts a daemon watch for one folder. Absent when the host cannot watch folders. */
  watch?: (path: string, onChange: () => void) => Promise<LiveDirectoryWatch>;
  /** Re-lists folders. Called at most once per window, with every folder that changed in it. */
  reload: (paths: string[]) => void;
  windowMs?: number;
  timers?: {
    setTimeout(callback: () => void, delayMs: number): unknown;
    clearTimeout(handle: unknown): void;
  };
}

const DEFAULT_WINDOW_MS = 300;

/**
 * Keeps the Files tree's open folders current: one daemon watch per open folder, released
 * when the folder closes or the tree unmounts, and one batched re-list per window for
 * every folder that reported a change. Without a daemon watch it still re-lists on
 * `reloadAll`, which the tree calls on foreground and reconnect.
 */
export class LiveExplorerDirectories {
  private readonly options: LiveExplorerDirectoriesOptions;
  private readonly timers: NonNullable<LiveExplorerDirectoriesOptions["timers"]>;
  private readonly paths = new Map<string, Promise<LiveDirectoryWatch | null> | null>();
  private readonly pending = new Set<string>();
  private timer: unknown = null;
  private disposed = false;

  constructor(options: LiveExplorerDirectoriesOptions) {
    this.options = options;
    this.timers = options.timers ?? {
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
  }

  setPaths(paths: Iterable<string>): void {
    if (this.disposed) return;
    const next = new Set(paths);
    for (const [path, watch] of this.paths) {
      if (next.has(path)) continue;
      this.paths.delete(path);
      this.pending.delete(path);
      release(watch);
    }
    for (const path of next) {
      if (this.paths.has(path)) continue;
      const watch = this.options.watch;
      this.paths.set(
        path,
        watch
          ? watch(path, () => this.changed(path)).catch(() => null) // Old listing stays; Refresh still works.
          : null,
      );
    }
  }

  /** Re-lists every open folder, for changes made while the app was away or offline. */
  reloadAll(): void {
    for (const path of this.paths.keys()) this.changed(path);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
    for (const watch of this.paths.values()) release(watch);
    this.paths.clear();
  }

  private changed(path: string): void {
    if (this.disposed || !this.paths.has(path)) return;
    this.pending.add(path);
    // Leading-edge window: a burst of changes becomes one re-list, and a folder that keeps
    // changing still re-lists once per window instead of never.
    if (this.timer !== null) return;
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      const paths = [...this.pending];
      this.pending.clear();
      if (paths.length > 0) this.options.reload(paths);
    }, this.options.windowMs ?? DEFAULT_WINDOW_MS);
  }
}

function release(watch: Promise<LiveDirectoryWatch | null> | null): void {
  void watch?.then((active) => active?.unsubscribe()).catch(() => undefined);
}
