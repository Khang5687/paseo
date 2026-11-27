import { afterEach, describe, expect, it } from "vitest";
import type { Note } from "@/notes/model";
import { ChatRowIndex, findNoteRange, readChatSelection } from "./dom.web";

afterEach(() => {
  document.body.replaceChildren();
});

interface RowSpec {
  id: string;
  role: "user" | "assistant" | "tool";
  html: string;
}

function transcript(rows: RowSpec[]): HTMLElement {
  const root = document.createElement("div");
  for (const spec of rows) {
    const row = document.createElement("div");
    row.dataset.historyRowId = spec.id;
    row.dataset.messageId = spec.id;
    if (spec.role === "tool") row.innerHTML = `<div>${spec.html}</div>`;
    else
      row.innerHTML = `<div data-testid="${spec.role}-message" data-message-text="true">${spec.html}</div>`;
    root.append(row);
  }
  document.body.append(root);
  return root;
}

function note(quote: string, anchor: Partial<Extract<Note["anchor"], { kind: "agent" }>>): Note {
  return {
    id: "note-1",
    text: "check",
    quote,
    anchor: { kind: "agent", agentId: "agent-1", ...anchor },
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-01T10:00:00.000Z",
  };
}

function textOf(root: HTMLElement, text: string): Text {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node instanceof Text && node.data.includes(text)) return node;
  }
  throw new Error(`No text node holds ${text}`);
}

function rangeBetween(start: Text, startOffset: number, end: Text, endOffset: number): Range {
  const range = document.createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset);
  return range;
}

describe("readChatSelection", () => {
  it("anchors a selection to its row and offsets in the row's text", () => {
    const root = transcript([
      { id: "u1", role: "user", html: "Please fix the login bug" },
      {
        id: "a1",
        role: "assistant",
        html: '<div data-paseo-markdown-tag="p">I found <strong>the bug</strong> in auth.</div>',
      },
    ]);
    const bug = textOf(root, "the bug");
    const auth = textOf(root, " in auth.");
    const selection = readChatSelection(root, rangeBetween(bug, 4, auth, 8));
    expect(selection).toEqual({
      row: expect.objectContaining({ rowId: "a1", messageId: "a1", role: "assistant" }),
      quote: "bug in auth",
      span: { start: 12, end: 23 },
    });
  });

  it("quotes every message row a selection crosses, without list markers or tool calls", () => {
    const root = transcript([
      {
        id: "a1",
        role: "assistant",
        html: '<div data-paseo-markdown-tag="li"><span data-paseo-markdown-ignore="true">•</span><span>First step</span></div>',
      },
      { id: "t1", role: "tool", html: "ran tests" },
      { id: "a2", role: "assistant", html: '<div data-paseo-markdown-tag="p">Then ship it</div>' },
    ]);
    const first = textOf(root, "First step");
    const then = textOf(root, "Then ship it");
    const selection = readChatSelection(root, rangeBetween(first, 6, then, 4));
    expect(selection?.row.rowId).toBe("a1");
    expect(selection?.quote).toBe("step\nThen");
    expect(selection?.span).toEqual({ start: 6, end: 10 });
  });

  it("ignores a selection outside message text", () => {
    const root = transcript([{ id: "t1", role: "tool", html: "ran tests" }]);
    const tool = textOf(root, "ran tests");
    expect(readChatSelection(root, rangeBetween(tool, 0, tool, 3))).toBeNull();
  });
});

describe("findNoteRange", () => {
  it("finds a note by its row offsets", () => {
    const root = transcript([
      { id: "a1", role: "assistant", html: "retry the retry loop" },
      { id: "a2", role: "assistant", html: "retry elsewhere" },
    ]);
    const range = findNoteRange(
      new ChatRowIndex(root),
      note("retry", { rowId: "a1", messageId: "a1", start: 10, end: 15 }),
    );
    expect(range?.toString()).toBe("retry");
    expect(range?.startOffset).toBe(10);
  });

  it("follows a quote that runs on into the next message rows", () => {
    const root = transcript([
      { id: "a1", role: "assistant", html: "First paragraph." },
      { id: "t1", role: "tool", html: "tool output" },
      { id: "a2", role: "assistant", html: "Second paragraph." },
    ]);
    const range = findNoteRange(
      new ChatRowIndex(root),
      note("paragraph.\nSecond", { rowId: "a1", messageId: "a1", start: 6, end: 16 }),
    );
    expect(range?.startContainer).toBe(textOf(root, "First"));
    expect(range?.endContainer).toBe(textOf(root, "Second"));
    expect(range?.endOffset).toBe(6);
  });

  it("does not guess when the note's mounted row no longer holds the quote", () => {
    const root = transcript([
      { id: "a1", role: "assistant", html: "rewritten" },
      { id: "a2", role: "assistant", html: "the quote" },
    ]);
    expect(findNoteRange(new ChatRowIndex(root), note("the quote", { rowId: "a1" }))).toBeNull();
  });

  it("finds a note whose row is not mounted by its quote", () => {
    const root = transcript([{ id: "a2", role: "assistant", html: "keep the quote here" }]);
    const range = findNoteRange(new ChatRowIndex(root), note("the quote", { rowId: "gone" }));
    expect(range?.toString()).toBe("the quote");
  });
});
