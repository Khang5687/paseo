import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileCopyStore, type FileCopyLimits } from "./store.js";

const SOURCE = "srv_mac";
const HOME = "/Users/me";
const DAY_MS = 24 * 60 * 60 * 1000;

describe("FileCopyStore", () => {
  let paseoHome: string;
  let clock: number;
  const stores: FileCopyStore[] = [];

  beforeEach(async () => {
    paseoHome = await mkdtemp(path.join(tmpdir(), "file-copies-"));
    clock = Date.parse("2026-11-01T00:00:00.000Z");
  });

  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.stop()));
    await rm(paseoHome, { recursive: true, force: true });
  });

  async function openStore(limits: Partial<FileCopyLimits> = {}): Promise<FileCopyStore> {
    const store = new FileCopyStore({
      paseoHome,
      logger: pino({ level: "silent" }),
      limits: { keepDays: 30, maxTotalBytes: 1000, maxFileBytes: 400, ...limits },
      now: () => new Date(clock),
    });
    stores.push(store);
    await store.start();
    return store;
  }

  async function put(store: FileCopyStore, filePath: string, content: string, revision = "r1") {
    const file = path.join(paseoHome, `upload-${Math.random()}`);
    await writeFile(file, content);
    return store.put({
      sourceServerId: SOURCE,
      sourceHome: HOME,
      path: filePath,
      size: Buffer.byteLength(content),
      mimeType: "text/plain",
      modifiedAt: new Date(clock).toISOString(),
      revision,
      file,
    });
  }

  function paths(store: FileCopyStore): string[] {
    return store
      .list()
      .map((entry) => entry.path)
      .sort();
  }

  it("removes copies not mentioned for the keep period, then the least recently mentioned", async () => {
    const store = await openStore();
    await put(store, "/Users/me/old.txt", "a".repeat(100));
    clock += 20 * DAY_MS;
    await put(store, "/Users/me/a.txt", "b".repeat(300));
    clock += 1000;
    await put(store, "/Users/me/b.txt", "c".repeat(300));
    clock += 1000;
    // Mentioning a.txt again makes b.txt the least recently mentioned.
    expect(
      await store.recordMentions(SOURCE, HOME, [{ path: "/Users/me/a.txt", revision: "r1" }]),
    ).toEqual([]);

    clock += 11 * DAY_MS;
    await put(store, "/Users/me/c.txt", "d".repeat(300));
    // old.txt expired (31 days); 900 bytes still fit.
    expect(paths(store)).toEqual(["/Users/me/a.txt", "/Users/me/b.txt", "/Users/me/c.txt"]);

    await put(store, "/Users/me/d.txt", "e".repeat(300));
    expect(paths(store)).toEqual(["/Users/me/a.txt", "/Users/me/c.txt", "/Users/me/d.txt"]);
    expect(store.usage()).toEqual({ totalBytes: 900, fileCount: 3 });
    expect(await readdir(path.join(paseoHome, "file-copies", "blobs"))).toHaveLength(3);
  });

  it("asks for an upload only when the copy is missing or at another revision", async () => {
    const store = await openStore();
    await put(store, "/Users/me/notes.md", "hello", "r1");
    clock += 5000;

    const needed = await store.recordMentions(SOURCE, HOME, [
      { path: "/Users/me/notes.md", revision: "r1" },
      { path: "/Users/me/plan.md", revision: "r1" },
    ]);
    expect(needed).toEqual(["/Users/me/plan.md"]);
    expect(store.list()[0].lastMentionedAt).toBe(new Date(clock).toISOString());

    expect(
      await store.recordMentions(SOURCE, HOME, [{ path: "/Users/me/notes.md", revision: "r2" }]),
    ).toEqual(["/Users/me/notes.md"]);
  });

  it("reads a copy by home path after a restart and replaces it in place", async () => {
    const first = await openStore();
    await put(first, "/Users/me/notes.md", "one", "r1");
    await first.stop();

    const store = await openStore();
    const found = store.resolve(SOURCE, "~/notes.md");
    expect(found?.entry).toMatchObject({ path: "/Users/me/notes.md", size: 3, revision: "r1" });
    expect(await readFile(found!.blobPath, "utf8")).toBe("one");

    await put(store, "/Users/me/notes.md", "two!", "r2");
    const replaced = store.resolve(SOURCE, "/Users/me/notes.md");
    expect(await readFile(replaced!.blobPath, "utf8")).toBe("two!");
    expect(await readdir(path.join(paseoHome, "file-copies", "blobs"))).toHaveLength(1);
    expect(store.resolve("srv_other", "/Users/me/notes.md")).toBeNull();
  });

  it("refuses a file over the per-file limit and drops copies when the limit shrinks", async () => {
    const store = await openStore();
    await expect(put(store, "/Users/me/big.bin", "x".repeat(401))).rejects.toThrow(/limit/);
    await put(store, "/Users/me/mid.bin", "x".repeat(300));
    await put(store, "/Users/me/small.bin", "x".repeat(10));

    await store.setLimits({ keepDays: 30, maxTotalBytes: 1000, maxFileBytes: 100 });
    expect(paths(store)).toEqual(["/Users/me/small.bin"]);
  });

  it("removes one copy", async () => {
    const store = await openStore();
    await put(store, "/Users/me/notes.md", "hello");
    expect(await store.remove(SOURCE, "~/notes.md")).toBe(true);
    expect(await store.remove(SOURCE, "~/notes.md")).toBe(false);
    expect(store.usage()).toEqual({ totalBytes: 0, fileCount: 0 });
  });
});
