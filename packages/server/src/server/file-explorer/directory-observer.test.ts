import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { DirectoryObserver, type DirectoryObserverDependencies } from "./directory-observer.js";

class ObservationControls implements DirectoryObserverDependencies {
  watches = 0;
  closes = 0;
  failWatch = false;
  private change: ((eventType: string, filename: string | null) => void) | null = null;
  private error: (() => void) | null = null;
  private timeout: (() => void) | null = null;
  interval: (() => void) | null = null;

  watchDirectory(
    _directory: string,
    onChange: (eventType: string, filename: string | null) => void,
    onError: () => void,
  ) {
    if (this.failWatch) throw Object.assign(new Error("no watchers left"), { code: "ENOSPC" });
    this.watches += 1;
    this.change = onChange;
    this.error = onError;
    return {
      close: () => {
        this.closes += 1;
        this.change = null;
      },
    };
  }

  setTimeout(callback: () => void): ReturnType<typeof setTimeout> {
    this.timeout = callback;
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }

  clearTimeout(): void {
    this.timeout = null;
  }

  setInterval(callback: () => void): ReturnType<typeof setInterval> {
    this.interval = callback;
    return 2 as unknown as ReturnType<typeof setInterval>;
  }

  clearInterval(): void {
    this.interval = null;
  }

  /** Delivers a watcher event without firing the settle timer. */
  event(eventType: string, filename: string | null): void {
    this.change?.(eventType, filename);
  }

  get settlePending(): boolean {
    return this.timeout !== null;
  }

  settle(): void {
    const timeout = this.timeout;
    this.timeout = null;
    timeout?.();
  }

  fail(): void {
    this.error?.();
  }
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-directory-observer-"));
  roots.push(root);
  await mkdir(path.join(root, "out"));
  await writeFile(path.join(root, "out", "first.txt"), "one", "utf8");
  return root;
}

describe("DirectoryObserver", () => {
  test("shares one watcher per folder and closes it with the last subscriber", async () => {
    const root = await workspace();
    const controls = new ObservationControls();
    const observer = new DirectoryObserver(controls);
    const calls = { first: 0, second: 0 };
    const first = await observer.subscribe({ cwd: root, path: "out" }, () => (calls.first += 1));
    const second = await observer.subscribe({ cwd: root, path: "./out/" }, () => {
      calls.second += 1;
    });

    await writeFile(path.join(root, "out", "clip.mp4"), "video", "utf8");
    controls.event("rename", "clip.mp4");
    controls.event("rename", "clip.mp4");
    controls.settle();
    await observer.settled();

    expect(controls.watches).toBe(1);
    expect(calls).toEqual({ first: 1, second: 1 });
    first.unsubscribe();
    expect(controls.closes).toBe(0);
    expect(observer.size).toBe(1);
    second.unsubscribe();
    expect(controls.closes).toBe(1);
    expect(observer.size).toBe(0);
  });

  test("ignores content writes and events that leave the names unchanged", async () => {
    const root = await workspace();
    const controls = new ObservationControls();
    const observer = new DirectoryObserver(controls);
    let calls = 0;
    const subscription = await observer.subscribe({ cwd: root, path: "out" }, () => (calls += 1));

    await writeFile(path.join(root, "out", "first.txt"), "longer content", "utf8");
    controls.event("change", "first.txt");
    expect(controls.settlePending).toBe(false);
    controls.event("rename", "first.txt");
    controls.settle();
    await observer.settled();

    expect(calls).toBe(0);
    subscription.unsubscribe();
  });

  test("delivers nothing after unsubscribe, even from a check already queued", async () => {
    const root = await workspace();
    const controls = new ObservationControls();
    const observer = new DirectoryObserver(controls);
    let calls = 0;
    const subscription = await observer.subscribe({ cwd: root, path: "out" }, () => (calls += 1));

    await writeFile(path.join(root, "out", "late.txt"), "late", "utf8");
    controls.event("rename", "late.txt");
    expect(controls.settlePending).toBe(true);
    subscription.unsubscribe();

    expect(controls.settlePending).toBe(false);
    expect(controls.closes).toBe(1);
    expect(observer.size).toBe(0);
    await observer.settled();
    expect(calls).toBe(0);
  });

  test("polls when the watcher cannot start, and dispose stops the poll", async () => {
    const root = await workspace();
    const controls = new ObservationControls();
    controls.failWatch = true;
    const observer = new DirectoryObserver(controls);
    let calls = 0;
    await observer.subscribe({ cwd: root, path: "out" }, () => (calls += 1));
    expect(controls.interval).not.toBeNull();

    await writeFile(path.join(root, "out", "polled.txt"), "x", "utf8");
    controls.interval?.();
    await observer.settled();
    expect(calls).toBe(1);

    observer.dispose();
    expect(controls.interval).toBeNull();
    expect(observer.size).toBe(0);
  });

  test("a watcher error switches to polling and a later check watches again", async () => {
    const root = await workspace();
    const controls = new ObservationControls();
    const observer = new DirectoryObserver(controls);
    let calls = 0;
    const subscription = await observer.subscribe({ cwd: root, path: "out" }, () => (calls += 1));

    controls.fail();
    expect(controls.closes).toBe(1);
    expect(controls.interval).not.toBeNull();
    await writeFile(path.join(root, "out", "after-error.txt"), "x", "utf8");
    controls.interval?.();
    await observer.settled();

    expect(calls).toBe(1);
    expect(controls.watches).toBe(2);
    expect(controls.interval).toBeNull();
    subscription.unsubscribe();
  });

  test("reports a deleted folder, then its return", async () => {
    const root = await workspace();
    const controls = new ObservationControls();
    const observer = new DirectoryObserver(controls);
    let calls = 0;
    const subscription = await observer.subscribe({ cwd: root, path: "out" }, () => (calls += 1));

    await rm(path.join(root, "out"), { recursive: true });
    controls.event("rename", "out");
    controls.settle();
    await observer.settled();
    expect(calls).toBe(1);
    expect(controls.interval).not.toBeNull();

    await mkdir(path.join(root, "out"));
    controls.interval?.();
    await observer.settled();
    expect(calls).toBe(2);
    expect(controls.watches).toBe(2);
    subscription.unsubscribe();
    expect(controls.interval).toBeNull();
  });

  test("rejects files, missing folders and paths outside the workspace", async () => {
    const root = await workspace();
    const observer = new DirectoryObserver(new ObservationControls());

    await expect(
      observer.subscribe({ cwd: root, path: "out/first.txt" }, () => undefined),
    ).rejects.toThrow("not a directory");
    await expect(observer.subscribe({ cwd: root, path: "gone" }, () => undefined)).rejects.toThrow(
      "Directory not found",
    );
    await expect(observer.subscribe({ cwd: root, path: ".." }, () => undefined)).rejects.toThrow();
    expect(observer.size).toBe(0);
  });

  test("notices a new file through the real filesystem watcher", async () => {
    const root = await workspace();
    const observer = new DirectoryObserver();
    let calls = 0;
    const subscription = await observer.subscribe({ cwd: root, path: "out" }, () => (calls += 1));
    try {
      await writeFile(path.join(root, "out", "real.txt"), "x", "utf8");
      await expect.poll(() => calls, { timeout: 5000 }).toBe(1);
    } finally {
      subscription.unsubscribe();
    }
    expect(observer.size).toBe(0);
  });
});
