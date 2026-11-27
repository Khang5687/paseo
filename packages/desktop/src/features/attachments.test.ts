import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendAttachmentBytes, copyAttachmentFileToManagedStorage } from "./attachments";

const originalPaseoHome = process.env.PASEO_HOME;
let testHome: string | null = null;

async function useTempPaseoHome(): Promise<string> {
  testHome = await mkdtemp(path.join(os.tmpdir(), "paseo-desktop-attachments-"));
  process.env.PASEO_HOME = testHome;
  return testHome;
}

describe("desktop attachment files", () => {
  afterEach(async () => {
    if (originalPaseoHome === undefined) {
      delete process.env.PASEO_HOME;
    } else {
      process.env.PASEO_HOME = originalPaseoHome;
    }

    if (testHome) {
      await rm(testHome, { recursive: true, force: true });
      testHome = null;
    }
  });

  it("accepts dot-prefixed picker extensions for managed copies", async () => {
    const paseoHome = await useTempPaseoHome();
    const sourcePath = path.join(paseoHome, "report.md");
    await writeFile(sourcePath, "# Report\n");

    const result = await copyAttachmentFileToManagedStorage({
      attachmentId: "att_markdown",
      sourcePath,
      extension: ".md",
    });

    expect(result).toEqual({
      path: path.join(paseoHome, "desktop-attachments", "att_markdown.md"),
      byteSize: 9,
    });
    await expect(readFile(result.path, "utf8")).resolves.toBe("# Report\n");
  });

  it("normalizes legacy bare extensions for managed copies", async () => {
    const paseoHome = await useTempPaseoHome();
    const sourcePath = path.join(paseoHome, "report.md");
    await writeFile(sourcePath, "# Report\n");

    const result = await copyAttachmentFileToManagedStorage({
      attachmentId: "att_markdown_legacy",
      sourcePath,
      extension: "md",
    });

    expect(result).toEqual({
      path: path.join(paseoHome, "desktop-attachments", "att_markdown_legacy.md"),
      byteSize: 9,
    });
    await expect(readFile(result.path, "utf8")).resolves.toBe("# Report\n");
  });

  it("builds one file from appended pieces, and starts over on reset", async () => {
    const paseoHome = await useTempPaseoHome();
    const piece = (text: string) => new TextEncoder().encode(text);
    const target = path.join(paseoHome, "desktop-attachments", "att_big.mp4");

    await appendAttachmentBytes({
      attachmentId: "att_big",
      bytes: piece("one "),
      extension: ".mp4",
      reset: true,
    });
    const second = await appendAttachmentBytes({
      attachmentId: "att_big",
      bytes: piece("two"),
      extension: ".mp4",
      reset: false,
    });

    expect(second).toEqual({ path: target, byteSize: 7 });
    await expect(readFile(target, "utf8")).resolves.toBe("one two");

    await appendAttachmentBytes({
      attachmentId: "att_big",
      bytes: piece("new"),
      extension: ".mp4",
      reset: true,
    });
    await expect(readFile(target, "utf8")).resolves.toBe("new");
  });
});
