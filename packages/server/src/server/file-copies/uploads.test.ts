import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, expect, it } from "vitest";
import { FILE_COPY_UPLOAD_NAME, removeLeftoverCopyUploads } from "./uploads.js";

let paseoHome: string;

beforeEach(async () => {
  paseoHome = await mkdtemp(path.join(tmpdir(), "file-copy-uploads-"));
});

afterEach(async () => {
  await rm(paseoHome, { recursive: true, force: true });
});

async function upload(names: string[], ageHours: number): Promise<string> {
  const id = `upload_${randomUUID()}`;
  const dir = path.join(paseoHome, "uploads", id);
  await mkdir(dir, { recursive: true });
  const time = new Date(Date.now() - ageHours * 60 * 60 * 1000);
  for (const name of names) {
    await writeFile(path.join(dir, name), "bytes");
    await utimes(path.join(dir, name), time, time);
  }
  return id;
}

it("removes only copy uploads older than a day and leaves every other upload", async () => {
  const leftover = await upload([FILE_COPY_UPLOAD_NAME], 25);
  const recent = await upload([FILE_COPY_UPLOAD_NAME], 1);
  const attachment = await upload(["photo.png"], 72);
  const mixed = await upload([FILE_COPY_UPLOAD_NAME, "notes.md"], 72);

  expect(await removeLeftoverCopyUploads(paseoHome, pino({ level: "silent" }))).toBe(1);

  const kept = await readdir(path.join(paseoHome, "uploads"));
  expect(kept.sort()).toEqual([recent, attachment, mixed].sort());
  expect(kept).not.toContain(leftover);
});
