import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveFile, sanitizeFileName } from "./file-save";

const bytes = (text: string) => new TextEncoder().encode(text);
const noManagedStorage = (): string => {
  throw new Error("Not in managed storage.");
};

describe("desktop file save", () => {
  let downloadsDir: string;

  beforeEach(async () => {
    downloadsDir = await mkdtemp(path.join(os.tmpdir(), "paseo-file-save-"));
  });

  afterEach(async () => {
    await rm(downloadsDir, { recursive: true, force: true });
  });

  it("with the question off, writes to Downloads/Paseo and never overwrites", async () => {
    const deps = {
      downloadsDir,
      chooseSavePath: async () => null,
      resolveSourcePath: noManagedStorage,
    };

    const first = await saveFile({ fileName: "report.pdf", bytes: bytes("one"), ask: false }, deps);
    const second = await saveFile(
      { fileName: "report.pdf", bytes: bytes("two"), ask: false },
      deps,
    );

    expect(first).toEqual({
      status: "saved",
      path: path.join(downloadsDir, "Paseo", "report.pdf"),
      folderLabel: "Downloads \u203a Paseo",
    });
    expect(second).toMatchObject({
      status: "saved",
      path: path.join(downloadsDir, "Paseo", "report (1).pdf"),
    });
    expect(await readFile(path.join(downloadsDir, "Paseo", "report.pdf"), "utf8")).toBe("one");
    expect(await readFile(path.join(downloadsDir, "Paseo", "report (1).pdf"), "utf8")).toBe("two");
  });

  it("with the question on, writes where the dialog says and starts it in Downloads", async () => {
    const target = path.join(downloadsDir, "elsewhere.txt");
    const asked: string[] = [];

    const result = await saveFile(
      { fileName: "note.txt", bytes: bytes("hello"), ask: true },
      {
        downloadsDir,
        resolveSourcePath: noManagedStorage,
        chooseSavePath: async (defaultPath) => {
          asked.push(defaultPath);
          return target;
        },
      },
    );

    expect(asked).toEqual([path.join(downloadsDir, "note.txt")]);
    expect(result).toEqual({
      status: "saved",
      path: target,
      folderLabel: path.basename(downloadsDir),
    });
    expect(await readFile(target, "utf8")).toBe("hello");
  });

  it("writes nothing when the dialog is cancelled", async () => {
    const result = await saveFile(
      { fileName: "note.txt", bytes: bytes("hello"), ask: true },
      { downloadsDir, chooseSavePath: async () => null, resolveSourcePath: noManagedStorage },
    );

    expect(result).toEqual({ status: "cancelled" });
    expect(await readdir(downloadsDir)).toEqual([]);
  });

  it("keeps a name with path parts inside the folder", async () => {
    await writeFile(path.join(downloadsDir, "keep.txt"), "x");
    const result = await saveFile(
      { fileName: "../../keep.txt", bytes: bytes("y"), ask: false },
      { downloadsDir, chooseSavePath: async () => null, resolveSourcePath: noManagedStorage },
    );

    expect(result).toMatchObject({ path: path.join(downloadsDir, "Paseo", "keep.txt") });
    expect(sanitizeFileName("..")).toBe("download");
  });

  it("copies a managed file instead of taking its bytes, and never overwrites", async () => {
    const source = path.join(downloadsDir, "managed.bin");
    await writeFile(source, "big file");
    const deps = {
      downloadsDir,
      chooseSavePath: async () => null,
      resolveSourcePath: (value: string) => value,
    };

    const first = await saveFile({ fileName: "video.mp4", sourcePath: source, ask: false }, deps);
    const second = await saveFile({ fileName: "video.mp4", sourcePath: source, ask: false }, deps);

    expect(first).toMatchObject({ path: path.join(downloadsDir, "Paseo", "video.mp4") });
    expect(second).toMatchObject({ path: path.join(downloadsDir, "Paseo", "video (1).mp4") });
    expect(await readFile(path.join(downloadsDir, "Paseo", "video (1).mp4"), "utf8")).toBe(
      "big file",
    );
  });

  it("refuses a source path outside managed storage", async () => {
    await expect(
      saveFile(
        { fileName: "passwd", sourcePath: "/etc/passwd", ask: false },
        { downloadsDir, chooseSavePath: async () => null, resolveSourcePath: noManagedStorage },
      ),
    ).rejects.toThrow("Not in managed storage.");
    expect(await readdir(downloadsDir)).toEqual([]);
  });
});
