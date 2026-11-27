import { describe, expect, it } from "vitest";
import { fileNameFromWebUrl, findSavedLinkCopy } from "./link-copy";
import type { OfflineFile } from "./store";

function saved(serverId: string, filePath: string, savedAt: number): OfflineFile {
  return {
    serverId,
    path: filePath,
    size: 1,
    modifiedAt: "2026-11-27T00:00:00.000Z",
    kind: "binary",
    mimeType: "application/vnd.android.package-archive",
    savedAt,
    pinned: true,
    attachment: {
      id: `${serverId}:${filePath}:${savedAt}`,
      mimeType: "application/octet-stream",
      storageType: "native-file",
      storageKey: filePath,
      createdAt: savedAt,
    },
  };
}

const MESSAGE_AT = 1_000;
const APK = "/home/k/Downloads/paseo-fork-main.apk";

describe("findSavedLinkCopy", () => {
  it("opens a copy saved after the message", () => {
    const copy = saved("srv_omen", APK, MESSAGE_AT + 60_000);
    expect(
      findSavedLinkCopy([copy], { kind: "name", fileName: "paseo-fork-main.apk" }, MESSAGE_AT),
    ).toBe(copy);
  });

  it("never opens an older copy with the same name, so an old build cannot open", () => {
    const oldBuild = saved("srv_omen", APK, MESSAGE_AT - 1);
    expect(
      findSavedLinkCopy([oldBuild], { kind: "name", fileName: "paseo-fork-main.apk" }, MESSAGE_AT),
    ).toBeNull();
    expect(
      findSavedLinkCopy([oldBuild], { kind: "path", serverId: "srv_omen", path: APK }, MESSAGE_AT),
    ).toBeNull();
  });

  it("picks the newest of several copies saved after the message", () => {
    const first = saved("srv_omen", APK, MESSAGE_AT + 1);
    const second = saved("srv_mac", "/Users/k/Downloads/paseo-fork-main.apk", MESSAGE_AT + 2);
    expect(
      findSavedLinkCopy(
        [first, second],
        { kind: "name", fileName: "paseo-fork-main.apk" },
        MESSAGE_AT,
      ),
    ).toBe(second);
  });

  it("matches a file path only on its own host", () => {
    const copy = saved("srv_omen", APK, MESSAGE_AT + 1);
    expect(
      findSavedLinkCopy([copy], { kind: "path", serverId: "srv_mac", path: APK }, MESSAGE_AT),
    ).toBeNull();
    expect(
      findSavedLinkCopy([copy], { kind: "path", serverId: "srv_omen", path: APK }, MESSAGE_AT),
    ).toBe(copy);
  });

  it("matches a bare name as a whole last segment", () => {
    const copy = saved("srv_omen", APK, MESSAGE_AT + 1);
    const target = (suffix: string) => ({ kind: "suffix" as const, serverId: "srv_omen", suffix });
    expect(findSavedLinkCopy([copy], target("paseo-fork-main.apk"), MESSAGE_AT)).toBe(copy);
    expect(findSavedLinkCopy([copy], target("Downloads/paseo-fork-main.apk"), MESSAGE_AT)).toBe(
      copy,
    );
    expect(findSavedLinkCopy([copy], target("fork-main.apk"), MESSAGE_AT)).toBeNull();
  });
});

describe("fileNameFromWebUrl", () => {
  it("reads the decoded file name of an http link", () => {
    expect(fileNameFromWebUrl("http://100.96.217.71:8486/builds/paseo-fork-main.apk")).toBe(
      "paseo-fork-main.apk",
    );
    expect(fileNameFromWebUrl("https://example.com/files/My%20Report.pdf?x=1")).toBe(
      "My Report.pdf",
    );
  });

  it("ignores pages and other schemes", () => {
    expect(fileNameFromWebUrl("https://github.com/getpaseo/paseo")).toBeNull();
    expect(fileNameFromWebUrl("https://example.com/docs/")).toBeNull();
    expect(fileNameFromWebUrl("mailto:k@example.com")).toBeNull();
  });
});
