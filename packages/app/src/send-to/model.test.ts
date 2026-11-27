import { describe, expect, it } from "vitest";
import type { FileDevice } from "@getpaseo/client/internal/daemon-client";
import { fileNameOf, listSendTargets } from "./model";

const device = (deviceId: string, name: string, reachable: boolean): FileDevice => ({
  deviceId,
  name,
  kind: "phone",
  reachable,
  lastSeenAt: "2026-11-26T00:00:00.000Z",
});

describe("listSendTargets", () => {
  it("leaves out the device that holds the menu and lists reachable devices first", () => {
    const devices = [
      device("web", "Web browser", false),
      device("me", "Mac app", true),
      device("pixel", "Pixel", true),
      device("ipad", "iPad", true),
    ];
    expect(listSendTargets(devices, "me").map((d) => d.name)).toEqual([
      "iPad",
      "Pixel",
      "Web browser",
    ]);
  });
});

describe("fileNameOf", () => {
  it("takes the last path segment on either separator", () => {
    expect(fileNameOf("/home/k/out/clip.mp4")).toBe("clip.mp4");
    expect(fileNameOf("C:\\out\\clip.mp4")).toBe("clip.mp4");
  });
});
