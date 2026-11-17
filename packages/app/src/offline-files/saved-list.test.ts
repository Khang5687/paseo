import { describe, expect, it } from "vitest";
import { groupSavedFiles } from "./saved-list";
import type { OfflineFile } from "./store";

function saved(serverId: string, filePath: string, size: number, savedAt: number): OfflineFile {
  return {
    serverId,
    path: filePath,
    size,
    modifiedAt: "2026-11-16T00:00:00.000Z",
    kind: "text",
    mimeType: "text/plain",
    savedAt,
    attachment: {
      id: `${serverId}:${filePath}`,
      mimeType: "text/plain",
      storageType: "native-file",
      storageKey: filePath,
      createdAt: savedAt,
    },
  };
}

const FILES = [
  saved("srv_omen", "/home/k/notes/plan.md", 300, 1),
  saved("srv_mac", "/Users/k/repo/README.md", 100, 2),
  saved("srv_mac", "/Users/k/repo/docs/Plan.md", 50, 5),
  saved("srv_gone", "/tmp/old.txt", 10, 9),
];

type Group = ReturnType<typeof groupSavedFiles>[number];
const pathsOf = (group: Group) => group.files.map((file) => file.path);

describe("groupSavedFiles", () => {
  it("groups by host in host order, newest first, with each host's total size", () => {
    const groups = groupSavedFiles(FILES, { query: "", hostOrder: ["srv_mac", "srv_omen"] });
    expect(
      groups.map((group) => ({
        serverId: group.serverId,
        totalBytes: group.totalBytes,
        paths: pathsOf(group),
      })),
    ).toEqual([
      {
        serverId: "srv_mac",
        totalBytes: 150,
        paths: ["/Users/k/repo/docs/Plan.md", "/Users/k/repo/README.md"],
      },
      { serverId: "srv_omen", totalBytes: 300, paths: ["/home/k/notes/plan.md"] },
      // A host the app no longer knows still lists its files, last.
      { serverId: "srv_gone", totalBytes: 10, paths: ["/tmp/old.txt"] },
    ]);
  });

  it("keeps only paths containing the search, ignoring case, and drops empty hosts", () => {
    const groups = groupSavedFiles(FILES, { query: " PLAN ", hostOrder: ["srv_mac", "srv_omen"] });
    expect(groups.map((group) => [group.serverId, pathsOf(group)])).toEqual([
      ["srv_mac", ["/Users/k/repo/docs/Plan.md"]],
      ["srv_omen", ["/home/k/notes/plan.md"]],
    ]);
    expect(groups[0]?.totalBytes).toBe(50);
  });
});
