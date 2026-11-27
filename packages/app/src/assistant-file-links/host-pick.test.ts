import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pickFileHost, type FileHostCandidate } from "./host-pick";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A host whose filesystem is a temp folder; `~` is that folder. */
async function fakeHost(serverId: string, files: string[]): Promise<FileHostCandidate> {
  const home = await mkdtemp(path.join(tmpdir(), `host-${serverId}-`));
  roots.push(home);
  for (const file of files) {
    await mkdir(path.dirname(path.join(home, file)), { recursive: true });
    await writeFile(path.join(home, file), "x");
  }
  const expand = (value: string) => (value.startsWith("~") ? home + value.slice(1) : value);
  return {
    serverId,
    label: serverId,
    client: {
      async listDirectory(_cwd, directory) {
        const absolute = expand(directory);
        const names = await readdir(absolute);
        const entries = await Promise.all(
          names.map(async (name) => ({
            name,
            kind: (await stat(path.join(absolute, name))).isDirectory()
              ? ("directory" as const)
              : ("file" as const),
          })),
        );
        return { entries };
      },
    },
    hasSavedCopy: async () => false,
  };
}

function offlineHost(serverId: string, savedPaths: string[]): FileHostCandidate {
  return {
    serverId,
    label: serverId,
    client: null,
    hasSavedCopy: async (filePath) => savedPaths.includes(filePath),
  };
}

describe("pickFileHost", () => {
  it("opens a home file from the one host that has it, without asking", async () => {
    const mac = await fakeHost("mac", ["notes/a.md"]);
    const omen = await fakeHost("omen", ["notes/plan.md"]);
    const choose = vi.fn();
    await expect(
      pickFileHost({ path: "~/notes/plan.md", chatServerId: "mac", hosts: [mac, omen], choose }),
    ).resolves.toEqual({ kind: "otherHost", serverId: "omen" });
    await expect(
      pickFileHost({ path: "~/notes/a.md", chatServerId: "mac", hosts: [mac, omen], choose }),
    ).resolves.toEqual({ kind: "chatHost" });
    expect(choose).not.toHaveBeenCalled();
  });

  it("asks which host when several have the file, chat host listed first", async () => {
    const mac = await fakeHost("mac", ["notes/plan.md"]);
    const omen = await fakeHost("omen", ["notes/plan.md"]);
    const choose = vi.fn(async () => "omen");
    await expect(
      pickFileHost({ path: "~/notes/plan.md", chatServerId: "mac", hosts: [mac, omen], choose }),
    ).resolves.toEqual({ kind: "otherHost", serverId: "omen" });
    expect(choose).toHaveBeenCalledWith([
      { serverId: "mac", label: "mac", savedCopy: false },
      { serverId: "omen", label: "omen", savedCopy: false },
    ]);
  });

  it("does nothing when the chooser closes without a choice", async () => {
    const mac = await fakeHost("mac", ["notes/plan.md"]);
    const omen = await fakeHost("omen", ["notes/plan.md"]);
    await expect(
      pickFileHost({
        path: "~/notes/plan.md",
        chatServerId: "mac",
        hosts: [mac, omen],
        choose: async () => null,
      }),
    ).resolves.toEqual({ kind: "cancelled" });
  });

  it("does not take a folder of the same name for the file", async () => {
    const mac = await fakeHost("mac", []);
    const omen = await fakeHost("omen", ["notes/plan.md/inner.txt"]);
    await expect(
      pickFileHost({
        path: "~/notes/plan.md",
        chatServerId: "mac",
        hosts: [mac, omen],
        choose: vi.fn(),
      }),
    ).resolves.toEqual({ kind: "chatHost" });
  });

  it("uses an offline host's saved copy, and stays on the chat host when nobody has the file", async () => {
    const mac = offlineHost("mac", ["/Users/k/report.md"]);
    const omen = await fakeHost("omen", []);
    await expect(
      pickFileHost({
        path: "/Users/k/report.md",
        chatServerId: "omen",
        hosts: [omen, mac],
        choose: vi.fn(),
      }),
    ).resolves.toEqual({ kind: "otherHost", serverId: "mac" });
    await expect(
      pickFileHost({
        path: "/Users/k/missing.md",
        chatServerId: "omen",
        hosts: [omen, mac],
        choose: vi.fn(),
      }),
    ).resolves.toEqual({ kind: "chatHost" });
  });

  it("treats a host that errors or hangs as not having the file", async () => {
    const omen: FileHostCandidate = {
      serverId: "omen",
      label: "omen",
      client: {
        listDirectory: async () => ({ entries: [{ name: "plan.md", kind: "file" as const }] }),
      },
      hasSavedCopy: async () => false,
    };
    const broken: FileHostCandidate = {
      serverId: "broken",
      label: "broken",
      client: { listDirectory: () => Promise.reject(new Error("boom")) },
      hasSavedCopy: async () => false,
    };
    const hung: FileHostCandidate = {
      serverId: "hung",
      label: "hung",
      client: { listDirectory: () => new Promise(() => {}) },
      hasSavedCopy: async () => false,
    };
    vi.useFakeTimers();
    try {
      const pick = pickFileHost({
        path: "~/notes/plan.md",
        chatServerId: "broken",
        hosts: [broken, hung, omen],
        choose: vi.fn(),
      });
      await vi.advanceTimersByTimeAsync(5000);
      await expect(pick).resolves.toEqual({ kind: "otherHost", serverId: "omen" });
    } finally {
      vi.useRealTimers();
    }
  });
});
