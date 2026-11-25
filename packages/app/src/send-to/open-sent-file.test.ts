import { describe, expect, it, vi } from "vitest";
import { openSentFile, type OpenSentFileDeps } from "./open-sent-file";

const target = { serverId: "omen", path: "/home/k/clip.mp4" };

function deps(overrides: Partial<OpenSentFileDeps> = {}): OpenSentFileDeps {
  return {
    waitForHost: async () => true,
    save: vi.fn(async () => ({ status: "saved" as const })),
    openSaved: vi.fn(),
    ...overrides,
  };
}

describe("openSentFile", () => {
  it("saves the file, then opens the saved copy", async () => {
    const calls: string[] = [];
    const d = deps({
      save: async () => {
        calls.push("save");
        return { status: "saved" };
      },
      openSaved: () => calls.push("open"),
    });
    await expect(openSentFile(target, d)).resolves.toEqual({ status: "opened" });
    expect(calls).toEqual(["save", "open"]);
  });

  it("opens the copy it already has", async () => {
    const d = deps({ save: async () => ({ status: "fresh" }) });
    await expect(openSentFile(target, d)).resolves.toEqual({ status: "opened" });
    expect(d.openSaved).toHaveBeenCalledWith(target);
  });

  it("reports an offline host without saving or opening anything", async () => {
    const d = deps({ waitForHost: async () => false });
    await expect(openSentFile(target, d)).resolves.toEqual({ status: "hostOffline" });
    expect(d.save).not.toHaveBeenCalled();
    expect(d.openSaved).not.toHaveBeenCalled();
  });

  it("does not open a file that did not save", async () => {
    const tooLarge = deps({ save: async () => ({ status: "tooLarge", maxFileMb: 10 }) });
    await expect(openSentFile(target, tooLarge)).resolves.toEqual({
      status: "tooLarge",
      maxFileMb: 10,
    });
    expect(tooLarge.openSaved).not.toHaveBeenCalled();

    const failed = deps({ save: async () => ({ status: "failed", error: "File not found" }) });
    await expect(openSentFile(target, failed)).resolves.toEqual({
      status: "failed",
      error: "File not found",
    });
    expect(failed.openSaved).not.toHaveBeenCalled();
  });
});
