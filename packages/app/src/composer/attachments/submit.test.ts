import { describe, expect, it } from "vitest";
import type { AttachmentMetadata, ComposerAttachment } from "@/attachments/types";
import { applySendOriginalToImages, splitComposerAttachmentsForSubmit } from "./submit";

const picture: AttachmentMetadata = {
  id: "att_photo",
  mimeType: "image/jpeg",
  storageType: "web-indexeddb",
  storageKey: "att_photo",
  createdAt: 0,
};

const issue: ComposerAttachment = {
  kind: "forge_issue",
  item: {
    kind: "issue",
    number: 7,
    title: "Photos fail",
    url: "https://example.com/7",
    state: "open",
    body: null,
    labels: [],
  },
};

describe("applySendOriginalToImages", () => {
  it("marks the outgoing pictures so every send path skips resizing", () => {
    const outgoing = applySendOriginalToImages([{ kind: "image", metadata: picture }, issue], true);

    expect(splitComposerAttachmentsForSubmit(outgoing).images).toEqual([
      { ...picture, sendOriginal: true },
    ]);
    expect(outgoing[1]).toBe(issue);
    expect(picture.sendOriginal).toBeUndefined();
  });

  it("clears the mark from pictures a failed send put back once the switch is off", () => {
    const restored = applySendOriginalToImages([{ kind: "image", metadata: picture }], true);

    const outgoing = applySendOriginalToImages(restored, false);

    expect(splitComposerAttachmentsForSubmit(outgoing).images).toEqual([picture]);
  });
});
