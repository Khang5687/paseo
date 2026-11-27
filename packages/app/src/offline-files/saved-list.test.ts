import { describe, expect, it } from "vitest";
import {
  arrangeSavedFiles,
  describeSavedFiles,
  filterSavedFiles,
  groupSavedFiles,
  savedFileProject,
  savedFileType,
  type SavedFileItem,
  type SavedFilters,
  type SavedGrouping,
  type SavedSort,
} from "./saved-list";
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

describe("savedFileProject", () => {
  const roots = [
    { path: "/home/k/git/paseo", name: "paseo" },
    { path: "/home/k/git/paseo/packages/app/", name: "app" },
  ];

  it("names the deepest known folder that holds the file", () => {
    expect(savedFileProject("/home/k/git/paseo/packages/app/src/x.ts", roots)).toBe("app");
    expect(savedFileProject("/home/k/git/paseo/README.md", roots)).toBe("paseo");
  });

  it("does not take a sibling folder that only shares the name's start", () => {
    expect(savedFileProject("/home/k/git/paseo-sync/notes.md", roots)).toBe("paseo-sync");
  });

  it("falls back to the folder the file sits in", () => {
    expect(savedFileProject("/tmp/builds/app.apk", [])).toBe("builds");
  });
});

describe("savedFileType", () => {
  it("sorts files into the type chips by extension, ignoring case", () => {
    const typeOf = (path: string) => savedFileType({ path, kind: "binary" });
    expect(typeOf("/out/paseo-fork-main.apk")).toBe("apps");
    expect(typeOf("/shots/Phone.PNG")).toBe("images");
    expect(typeOf("/docs/plan.md")).toBe("docs");
    expect(typeOf("/src/link-copy.ts")).toBe("code");
    expect(typeOf("/repo/Makefile")).toBeNull();
  });

  it("counts a file the host read as an image under Images", () => {
    expect(savedFileType({ path: "/shots/screen", kind: "image" })).toBe("images");
  });
});

const NOW = new Date(2026, 10, 27, 15, 0).getTime();
const HOUR = 60 * 60 * 1000;

function items(): SavedFileItem[] {
  const files = [
    { ...saved("srv_omen", "/home/k/git/paseo/out/app.apk", 900, NOW - HOUR), sent: true },
    saved("srv_omen", "/home/k/git/paseo/docs/plan.md", 40, NOW - 20 * HOUR),
    saved("srv_mac", "/Users/k/fitup/shots/home.png", 300, NOW - 3 * 24 * HOUR),
    saved("srv_mac", "/Users/k/fitup/src/app.ts", 10, NOW - 30 * 24 * HOUR),
  ];
  return describeSavedFiles(files, {
    rootsByServer: new Map([
      ["srv_omen", [{ path: "/home/k/git/paseo", name: "paseo" }]],
      ["srv_mac", [{ path: "/Users/k/fitup", name: "FitUp" }]],
    ]),
    hostLabels: new Map([
      ["srv_omen", "Omen"],
      ["srv_mac", "Mac"],
    ]),
  });
}

const ALL: SavedFilters = { query: "", kind: "all", project: null, serverId: null };
const namesOf = (list: readonly SavedFileItem[]) => list.map((item) => item.name);

describe("filterSavedFiles", () => {
  it("keeps only files another device sent here under Sent to me", () => {
    expect(namesOf(filterSavedFiles(items(), { ...ALL, kind: "sent" }))).toEqual(["app.apk"]);
  });

  it("combines a type chip with the Device chip", () => {
    expect(
      namesOf(filterSavedFiles(items(), { ...ALL, kind: "code", serverId: "srv_mac" })),
    ).toEqual(["app.ts"]);
    expect(
      namesOf(filterSavedFiles(items(), { ...ALL, kind: "code", serverId: "srv_omen" })),
    ).toEqual([]);
  });

  it("matches the search against the project and device names too", () => {
    expect(namesOf(filterSavedFiles(items(), { ...ALL, query: "fitup" }))).toEqual([
      "home.png",
      "app.ts",
    ]);
    expect(namesOf(filterSavedFiles(items(), { ...ALL, query: "OMEN" }))).toEqual([
      "app.apk",
      "plan.md",
    ]);
  });
});

describe("arrangeSavedFiles", () => {
  const arrange = (input: { sort: SavedSort; grouping: SavedGrouping }) =>
    arrangeSavedFiles(items(), { ...input, now: NOW }).map((section) => ({
      key: section.key,
      bytes: section.totalBytes,
      names: namesOf(section.items),
    }));

  it("puts newest files under Today, Yesterday, This week and Earlier", () => {
    expect(arrange({ sort: "newest", grouping: "day" })).toEqual([
      { key: "day:today", bytes: 900, names: ["app.apk"] },
      { key: "day:yesterday", bytes: 40, names: ["plan.md"] },
      { key: "day:week", bytes: 300, names: ["home.png"] },
      { key: "day:earlier", bytes: 10, names: ["app.ts"] },
    ]);
  });

  it("drops day headings when sorted by size or name", () => {
    expect(arrange({ sort: "biggest", grouping: "day" })).toEqual([
      { key: "all", bytes: 1250, names: ["app.apk", "home.png", "plan.md", "app.ts"] },
    ]);
    expect(arrange({ sort: "name", grouping: "day" })[0]?.names).toEqual([
      "app.apk",
      "app.ts",
      "home.png",
      "plan.md",
    ]);
  });

  it("groups by project A to Z and sorts inside each project", () => {
    expect(arrange({ sort: "biggest", grouping: "project" })).toEqual([
      { key: "project:FitUp", bytes: 310, names: ["home.png", "app.ts"] },
      { key: "project:paseo", bytes: 940, names: ["app.apk", "plan.md"] },
    ]);
  });
});
