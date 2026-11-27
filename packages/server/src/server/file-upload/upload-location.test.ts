import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createUploadFile,
  isUploadId,
  removeUploadFile,
  resolveUploadFile,
} from "./upload-location.js";

const tempDirs: string[] = [];

function makePaseoHome(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "upload-location-test-")));
  tempDirs.push(root);
  return root;
}

describe("upload locations", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("names the day folder after the host's local date", async () => {
    const paseoHome = makePaseoHome();

    const file = await createUploadFile(paseoHome, "a.txt", new Date(2026, 10, 5, 23, 59));

    expect(file.id).toBe("2026-11-05/a.txt");
    expect(file.path).toBe(join(paseoHome, "uploads", "2026-11-05", "a.txt"));
  });

  it("keeps the extension and the name limit when it numbers a long name", async () => {
    const paseoHome = makePaseoHome();
    const name = `${"a".repeat(251)}.png`;

    await createUploadFile(paseoHome, name);
    const second = await createUploadFile(paseoHome, name);

    expect(second.path.endsWith("-2.png")).toBe(true);
    expect(Buffer.byteLength(second.id.split("/")[1])).toBeLessThanOrEqual(255);
  });

  it("resolves old upload_<uuid> folders and dated ids", async () => {
    const paseoHome = makePaseoHome();
    const legacyId = "upload_123e4567-e89b-12d3-a456-426614174000";
    mkdirSync(join(paseoHome, "uploads", legacyId), { recursive: true });
    writeFileSync(join(paseoHome, "uploads", legacyId, "old.pdf"), "x");
    const dated = await createUploadFile(paseoHome, "new.pdf");

    await expect(resolveUploadFile(paseoHome, legacyId)).resolves.toEqual({
      path: join(paseoHome, "uploads", legacyId, "old.pdf"),
      fileName: "old.pdf",
    });
    await expect(resolveUploadFile(paseoHome, dated.id)).resolves.toEqual({
      path: dated.path,
      fileName: "new.pdf",
    });
  });

  it("rejects ids that could leave the uploads folder", () => {
    for (const id of [
      "../x",
      "2026-11-05/../../x",
      "2026-11-05/..",
      "2026-11-05/a/b",
      "/etc/passwd",
    ]) {
      expect(isUploadId(id)).toBe(false);
    }
  });

  it("removes only the named file and drops the day folder once it is empty", async () => {
    const paseoHome = makePaseoHome();
    const first = await createUploadFile(paseoHome, "one.txt");
    const second = await createUploadFile(paseoHome, "two.txt");

    await removeUploadFile(paseoHome, first.id);
    expect(existsSync(first.path)).toBe(false);
    expect(existsSync(second.path)).toBe(true);

    await removeUploadFile(paseoHome, second.id);
    expect(readdirSync(join(paseoHome, "uploads"))).toEqual([]);
  });
});
