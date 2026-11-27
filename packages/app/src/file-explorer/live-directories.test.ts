import { describe, expect, it } from "vitest";
import { LiveExplorerDirectories, type LiveDirectoryWatch } from "./live-directories";

function harness(options: { canWatch?: boolean; failingPaths?: string[] } = {}) {
  const watching = new Map<string, () => void>();
  const released: string[] = [];
  const reloads: string[][] = [];
  let tick: (() => void) | null = null;
  const live = new LiveExplorerDirectories({
    watch:
      options.canWatch === false
        ? undefined
        : async (path, onChange): Promise<LiveDirectoryWatch> => {
            if (options.failingPaths?.includes(path)) throw new Error("Directory not found");
            watching.set(path, onChange);
            return {
              unsubscribe: async () => {
                watching.delete(path);
                released.push(path);
              },
            };
          },
    reload: (paths) => reloads.push(paths),
    timers: {
      setTimeout: (callback) => {
        tick = callback;
        return 1;
      },
      clearTimeout: () => {
        tick = null;
      },
    },
  });
  return {
    live,
    watching,
    released,
    reloads,
    change: (path: string) => watching.get(path)?.(),
    get windowOpen() {
      return tick !== null;
    },
    endWindow: () => {
      const callback = tick;
      tick = null;
      callback?.();
    },
  };
}

/** Lets the watch and release promise chains settle. */
async function flush() {
  for (let hop = 0; hop < 5; hop += 1) await Promise.resolve();
}

describe("LiveExplorerDirectories", () => {
  it("watches each open folder once and releases folders that close", async () => {
    const h = harness();
    h.live.setPaths([".", "out"]);
    h.live.setPaths([".", "out"]);
    await flush();
    expect([...h.watching.keys()]).toEqual([".", "out"]);

    h.live.setPaths(["."]);
    await flush();
    await flush();
    expect(h.released).toEqual(["out"]);
    expect([...h.watching.keys()]).toEqual(["."]);
  });

  it("re-lists every folder that changed in one window, once", async () => {
    const h = harness();
    h.live.setPaths([".", "out", "src"]);
    await flush();

    h.change("out");
    h.change("out");
    h.change(".");
    expect(h.reloads).toEqual([]);
    h.endWindow();

    expect(h.reloads).toEqual([["out", "."]]);
    h.change("src");
    h.endWindow();
    expect(h.reloads).toEqual([["out", "."], ["src"]]);
  });

  it("does not re-list a folder that closed while its change was waiting", async () => {
    const h = harness();
    h.live.setPaths([".", "out"]);
    await flush();
    h.change("out");
    h.live.setPaths(["."]);
    h.endWindow();
    expect(h.reloads).toEqual([]);
  });

  it("releases every watch on dispose and ignores late changes", async () => {
    const h = harness();
    h.live.setPaths([".", "out"]);
    await flush();
    const lateChange = h.watching.get("out");
    h.change("out");
    h.live.dispose();
    await flush();
    await flush();

    expect(h.windowOpen).toBe(false);
    expect(h.released.toSorted()).toEqual([".", "out"]);
    lateChange?.();
    expect(h.windowOpen).toBe(false);
    expect(h.reloads).toEqual([]);
  });

  it("releases a watch that finishes starting after its folder closed", async () => {
    const h = harness();
    h.live.setPaths([".", "out"]);
    h.live.setPaths(["."]);
    await flush();
    await flush();
    expect([...h.watching.keys()]).toEqual(["."]);
    expect(h.released).toEqual(["out"]);
  });

  it("re-lists open folders on reloadAll even when the host cannot watch", () => {
    const h = harness({ canWatch: false });
    h.live.setPaths([".", "out"]);
    h.live.reloadAll();
    h.endWindow();
    expect(h.watching.size).toBe(0);
    expect(h.reloads).toEqual([[".", "out"]]);
  });

  it("keeps other folders live when one watch fails to start", async () => {
    const h = harness({ failingPaths: ["gone"] });
    h.live.setPaths([".", "gone"]);
    await flush();
    h.change(".");
    h.endWindow();
    expect(h.reloads).toEqual([["."]]);
  });
});
