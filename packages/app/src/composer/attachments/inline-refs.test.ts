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

  it("renumbers tokens when the tray removes an attachment", () => {
    const attachments = [image("a"), image("b")];
    expect(
      removeInlineRefs({
        text: "[Image #1] vs [Image #2]",
        attachments,
        removed: new Set([0]),
        caret: 14,
      }),
    ).toEqual({ text: " vs [Image #1]", attachments: [attachments[1]], caret: 4 });
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
