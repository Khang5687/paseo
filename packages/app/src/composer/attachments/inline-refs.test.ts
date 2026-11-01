import { describe, expect, it } from "vitest";
import type { ComposerAttachment } from "@/attachments/types";
import { splitComposerAttachmentsForSubmit } from "@/composer/attachments/submit";
import {
  inlineRefLabels,
  insertInlineRefTokens,
  reconcileInlineRefEdit,
  removeInlineRefs,
} from "./inline-refs";

function image(id: string): ComposerAttachment {
  return {
    kind: "image",
    metadata: {
      id,
      mimeType: "image/png",
      storageType: "web-indexeddb",
      storageKey: id,
      createdAt: 0,
    },
  };
}

function file(id: string): ComposerAttachment {
  return {
    kind: "file",
    attachment: {
      type: "uploaded_file",
      id,
      fileName: `${id}.pdf`,
      mimeType: "application/pdf",
      size: 1,
      path: `/tmp/${id}.pdf`,
    },
  };
}

const workspaceFile: ComposerAttachment = {
  kind: "workspace_file",
  path: "src/a.ts",
  selection: { kind: "whole_file" },
};

describe("inline attachment refs", () => {
  it("numbers images and files by insertion order, skipping other attachments", () => {
    expect([...inlineRefLabels([image("a"), workspaceFile, file("b"), image("c")])]).toEqual([
      [0, "Image #1"],
      [2, "File #2"],
      [3, "Image #3"],
    ]);
  });

  it("inserts tokens at the caret", () => {
    expect(
      insertInlineRefTokens({
        text: "look at this please",
        selection: { start: 12, end: 12 },
        labels: ["Image #1"],
      }),
    ).toEqual({
      text: "look at this [Image #1] please",
      selection: { start: 24, end: 24 },
    });
  });

  it("deletes a whole token and its attachment on one backspace, renumbering the rest", () => {
    const attachments = [image("a"), file("b"), image("c")];
    const previous = "see [Image #1] and [File #2] and [Image #3]";
    const next = "see [Image #1 and [File #2] and [Image #3]";

    const result = reconcileInlineRefEdit({ previous, next, attachments });

    expect(result).toEqual({
      text: "see and [File #1] and [Image #2]",
      selection: { start: 4, end: 4 },
      attachments: [attachments[1], attachments[2]],
    });
  });

  it("leaves edits that do not touch a token alone", () => {
    expect(
      reconcileInlineRefEdit({
        previous: "[Image #1] hi",
        next: "[Image #1] hit",
        attachments: [image("a")],
      }),
    ).toBeNull();
  });

  it("removes the attachment when one backspace or delete lands on a chip", () => {
    const attachments = [image("a"), image("b")];
    const previous = "[Image #1] then [Image #2] ";
    // Delete key at the start of the second chip.
    const next = "[Image #1] then Image #2] ";

    expect(reconcileInlineRefEdit({ previous, next, attachments })).toEqual({
      text: "[Image #1] then ",
      selection: { start: 16, end: 16 },
      attachments: [attachments[0]],
    });
  });

  it("keeps attachments when select-all + type replaces the text", () => {
    expect(
      reconcileInlineRefEdit({
        previous: "Compare [Image #1] with [File #2] ",
        next: "Describe the image",
        attachments: [image("a"), file("b")],
      }),
    ).toBeNull();
  });

  it("keeps attachments when a selection spanning more than one chip is deleted", () => {
    const attachments = [image("a"), image("b")];
    expect(
      reconcileInlineRefEdit({ previous: "[Image #1] [Image #2] ", next: "", attachments }),
    ).toBeNull();
    expect(
      reconcileInlineRefEdit({ previous: "see [Image #1] now", next: "see now", attachments }),
    ).toBeNull();
  });

  it("keeps attachments when a draft restore or queue edit replaces the text programmatically", () => {
    expect(
      reconcileInlineRefEdit({
        previous: "[Image #1] old draft",
        next: "Describe the queued image",
        attachments: [image("a")],
      }),
    ).toBeNull();
  });

  it("renumbers tokens when the tray removes an attachment, leaving no double space", () => {
    const attachments = [image("a"), file("b")];
    expect(
      removeInlineRefs({
        text: "Compare this [Image #1] with [File #2] ",
        attachments,
        removed: new Set([0]),
        caret: 39,
      }),
    ).toEqual({ text: "Compare this with [File #1] ", attachments: [attachments[1]], caret: 28 });
  });

  it("maps each label to its wire image or attachment index", () => {
    const { attachmentRefs } = splitComposerAttachmentsForSubmit([
      file("a"),
      workspaceFile,
      image("b"),
    ]);
    expect(attachmentRefs).toEqual([
      { label: "File #1", attachmentIndex: 0 },
      { label: "Image #2", imageIndex: 0 },
    ]);
  });
});
