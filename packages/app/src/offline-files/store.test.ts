import { describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: vi.fn(), setItem: vi.fn() },
}));
vi.mock("@/attachments/service", () => ({}));

const { isSameOfflineVersion, selectOfflineEvictions } = await import("./store");
type OfflineFile = Parameters<typeof selectOfflineEvictions>[0][number];

const DAY = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;
const NOW = 100 * DAY;

function file(path: string, savedAt: number, size = MB): OfflineFile {
  return {
    serverId: "host",
    path,
    size,
    modifiedAt: "2026-11-01T00:00:00.000Z",
    kind: "text",
    mimeType: "text/plain",
    savedAt,
    attachment: {
      id: path,
      mimeType: "text/plain",
      storageType: "native-file",
      storageKey: path,
      createdAt: savedAt,
    },
  };
}

const paths = (files: OfflineFile[]) => files.map((entry) => entry.path);

describe("selectOfflineEvictions", () => {
  it("drops files older than the retention window", () => {
    const { keep, evict } = selectOfflineEvictions(
      [file("/fresh", NOW - DAY), file("/stale", NOW - 31 * DAY)],
      { offlineFilesRetentionDays: 30, offlineFilesMaxTotalMb: 500 },
      NOW,
    );
    expect(paths(keep)).toEqual(["/fresh"]);
    expect(paths(evict)).toEqual(["/stale"]);
  });

  it("evicts the oldest files until the rest fit the total cap", () => {
    const { keep, evict } = selectOfflineEvictions(
      [
        file("/old", NOW - 3 * DAY, 4 * MB),
        file("/mid", NOW - 2 * DAY, 4 * MB),
        file("/new", NOW - DAY, 4 * MB),
      ],
      { offlineFilesRetentionDays: 30, offlineFilesMaxTotalMb: 10 },
      NOW,
    );
    expect(paths(keep)).toEqual(["/new", "/mid"]);
    expect(paths(evict)).toEqual(["/old"]);
  });
});

describe("isSameOfflineVersion", () => {
  it("compares revisions when both have one, else size and modification time", () => {
    const base = { size: 1, modifiedAt: "a" };
    expect(isSameOfflineVersion({ ...base, revision: "r1" }, { ...base, revision: "r2" })).toBe(
      false,
    );
    expect(isSameOfflineVersion(base, { ...base })).toBe(true);
    expect(isSameOfflineVersion(base, { ...base, modifiedAt: "b" })).toBe(false);
  });
});
