import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildAgentPrompt, splitInlineRefNotes } from "./prompt-attachments.js";
import { saveInlineImages } from "./prompt-image-files.js";

const tempDirs: string[] = [];

function makePaseoHome(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "prompt-image-files-")));
  tempDirs.push(root);
  return root;
}

const png = Buffer.from("png-bytes").toString("base64");

describe("saveInlineImages", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("writes each pasted picture as image-<N>.<ext> in today's upload folder", async () => {
    const paseoHome = makePaseoHome();

    const paths = await saveInlineImages(
      paseoHome,
      [
        { data: png, mimeType: "image/png" },
        { data: png, mimeType: "image/jpeg" },
      ],
      [{ label: "Image #4", imageIndex: 1 }],
    );

    expect(paths?.map((path) => basename(path))).toEqual(["image-1.png", "image-4.jpg"]);
    expect(dirname(paths![0])).toMatch(/uploads\/\d{4}-\d{2}-\d{2}$/);
    expect(readFileSync(paths![0], "utf8")).toBe("png-bytes");
  });

  it("numbers a name another message already used that day", async () => {
    const paseoHome = makePaseoHome();
    const image = { data: png, mimeType: "image/png" };

    const [first] = (await saveInlineImages(paseoHome, [image], undefined))!;
    const [second] = (await saveInlineImages(paseoHome, [image], undefined))!;

    expect(basename(first)).toBe("image-1.png");
    expect(basename(second)).toBe("image-1-2.png");
    expect(existsSync(first)).toBe(true);
    expect(readdirSync(dirname(first))).toHaveLength(2);
  });

  it("writes nothing for a message without pictures", async () => {
    const paseoHome = makePaseoHome();

    await expect(saveInlineImages(paseoHome, [], undefined)).resolves.toBeUndefined();
    expect(existsSync(join(paseoHome, "uploads"))).toBe(false);
  });
});

describe("image path notes", () => {
  it("names the saved path in each picture's note, labeled or not", () => {
    const prompt = buildAgentPrompt(
      "Look at [Image #3]",
      [
        { data: "a", mimeType: "image/png" },
        { data: "b", mimeType: "image/png" },
      ],
      undefined,
      [{ label: "Image #3", imageIndex: 0 }],
      [
        "/home/u/.paseo/uploads/2026-11-25/image-3.png",
        "/home/u/.paseo/uploads/2026-11-25/image-2.png",
      ],
    );

    expect(prompt).toEqual([
      { type: "text", text: "Look at [Image #3]", placeholders: ["[Image #3]"] },
      {
        type: "text",
        mimeType: "text/plain",
        text: "[Image #3]: /home/u/.paseo/uploads/2026-11-25/image-3.png",
      },
      { type: "image", data: "a", mimeType: "image/png" },
      {
        type: "text",
        mimeType: "text/plain",
        text: "[Image #2]: /home/u/.paseo/uploads/2026-11-25/image-2.png",
      },
      { type: "image", data: "b", mimeType: "image/png" },
    ]);
  });

  it("drops the path notes from replayed history and keeps what the user typed", () => {
    const replayed = [
      "Save [Image #1] into the project",
      "[Image #1]: /home/u/.paseo/uploads/2026-11-25/image-1.png",
      "[Image #2]:",
    ].join("\n\n");

    expect(splitInlineRefNotes(replayed).text).toBe("Save [Image #1] into the project");
  });
});
