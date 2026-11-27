import { describe, expect, it, vi } from "vitest";
import type { OfflineFile } from "@/offline-files/store";
import { receiveSentFile, type ReceiveSentFileDeps } from "./receive-sent-file";

const target = { serverId: "omen", path: "/home/k/clip.mp4" };
const file: OfflineFile = {
  ...target,
  size: 4,
  modifiedAt: "2026-01-01T00:00:00Z",
  revision: "r1",
  kind: "binary",
  mimeType: "video/mp4",
  savedAt: 1,
  pinned: true,
  attachment: {
    id: "att",
    mimeType: "video/mp4",
    storageType: "web-indexeddb",
    storageKey: "att",
    createdAt: 1,
  },
};

function deps(overrides: Partial<ReceiveSentFileDeps> = {}): ReceiveSentFileDeps {
  return {
    waitForHost: async () => true,
    save: vi.fn(async () => ({ status: "saved" as const, file })),
    noteSaved: vi.fn(),
    ...overrides,
  };
}

describe("receiveSentFile", () => {
  it("saves the file, then says it is saved", async () => {
    const calls: string[] = [];
    const d = deps({
      save: async () => {
        calls.push("save");
        return { status: "saved", file };
      },
      noteSaved: () => calls.push("note"),
    });
    await expect(receiveSentFile(target, d)).resolves.toEqual({ status: "saved" });
    expect(calls).toEqual(["save", "note"]);
  });

  it("says the copy it already has is saved", async () => {
    const d = deps({ save: async () => ({ status: "fresh", file }) });
    await expect(receiveSentFile(target, d)).resolves.toEqual({ status: "saved" });
    expect(d.noteSaved).toHaveBeenCalledWith(target);
  });

  it("reports an offline host without saving or noting anything", async () => {
    const d = deps({ waitForHost: async () => false });
    await expect(receiveSentFile(target, d)).resolves.toEqual({ status: "hostOffline" });
    expect(d.save).not.toHaveBeenCalled();
    expect(d.noteSaved).not.toHaveBeenCalled();
  });

  it("does not note a file that did not save", async () => {
    const tooLarge = deps({ save: async () => ({ status: "tooLarge", maxFileMb: 10 }) });
    await expect(receiveSentFile(target, tooLarge)).resolves.toEqual({
      status: "tooLarge",
      maxFileMb: 10,
    });
    expect(tooLarge.noteSaved).not.toHaveBeenCalled();

    const failed = deps({ save: async () => ({ status: "failed", error: "File not found" }) });
    await expect(receiveSentFile(target, failed)).resolves.toEqual({
      status: "failed",
      error: "File not found",
    });
    expect(failed.noteSaved).not.toHaveBeenCalled();
  });
});
