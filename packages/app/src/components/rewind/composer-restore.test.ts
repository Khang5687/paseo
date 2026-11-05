import { describe, expect, test } from "vitest";
import { restoreComposerImages, restoreComposerTextIfEmpty } from "./composer-restore";
import { shouldRestoreComposerForRewindMode } from "./rewind-mode";

describe("restoreComposerTextIfEmpty", () => {
  test("restores the rewound message when the composer is empty", () => {
    expect(
      restoreComposerTextIfEmpty({
        currentText: "",
        rewoundText: "message before rewind",
      }),
    ).toBe("message before rewind");
  });

  test("preserves an existing composer draft", () => {
    expect(
      restoreComposerTextIfEmpty({
        currentText: "keep this draft",
        rewoundText: "message before rewind",
      }),
    ).toBe("keep this draft");
  });
});

describe("shouldRestoreComposerForRewindMode", () => {
  test("restores only conversation-mutating rewind modes", () => {
    expect(shouldRestoreComposerForRewindMode("conversation")).toBe(true);
    expect(shouldRestoreComposerForRewindMode("files")).toBe(false);
    expect(shouldRestoreComposerForRewindMode("both")).toBe(true);
  });
});

describe("restoreComposerImages", () => {
  const image = (id: string) => ({
    id,
    mimeType: "image/png",
    storageType: "web-indexeddb" as const,
    storageKey: id,
    createdAt: 1,
  });

  test("adds the rewound message images to the draft", () => {
    expect(
      restoreComposerImages({
        current: [],
        rewoundImages: [image("img-1"), image("img-2")],
      }),
    ).toEqual([
      { kind: "image", metadata: image("img-1") },
      { kind: "image", metadata: image("img-2") },
    ]);
  });

  test("keeps existing draft attachments and does not duplicate an image already attached", () => {
    const current = [{ kind: "image" as const, metadata: image("img-1") }];
    expect(restoreComposerImages({ current, rewoundImages: [image("img-1")] })).toBe(current);
    expect(restoreComposerImages({ current, rewoundImages: [image("img-2")] })).toEqual([
      ...current,
      { kind: "image", metadata: image("img-2") },
    ]);
  });
});
