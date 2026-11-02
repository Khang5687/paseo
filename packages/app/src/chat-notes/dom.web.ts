import type { Note } from "@/notes/model";
import { joinedOffset, locateQuote, nodeAtOffset, type TextSpan } from "./anchor";

const ROW_SELECTOR = "[data-history-row-id]";
const MESSAGE_TEXT_SELECTOR = '[data-message-text="true"]';
const IGNORED =
  '[data-paseo-markdown-ignore="true"], [aria-hidden="true"], button, [role="button"], svg, script, style';
const BLOCK_SELECTOR = ["p", "pre", "li", "td", "th", "h1", "h2", "h3", "h4", "h5", "h6"]
  .flatMap((tag) => [tag, `[data-paseo-markdown-tag="${tag}"]`])
  .join(",");

export interface ChatNoteRow {
  element: HTMLElement;
  rowId: string;
  messageId: string;
  role: "user" | "assistant";
}

/** A user or assistant message row; tool calls, plugins and footers carry no notes. */
function chatNoteRow(element: HTMLElement | null): ChatNoteRow | null {
  const rowId = element?.dataset.historyRowId;
  const messageId = element?.dataset.messageId;
  if (!element || !rowId || !messageId || element.dataset.pluginRow === "true") return null;
  let role: ChatNoteRow["role"] | null = null;
  if (element.querySelector('[data-testid="user-message"]')) role = "user";
  else if (element.querySelector('[data-testid="assistant-message"]')) role = "assistant";
  return role ? { element, rowId, messageId, role } : null;
}

function rowElementOf(node: Node): HTMLElement | null {
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest<HTMLElement>(ROW_SELECTOR) ?? null;
}

/**
 * The text a note's offsets count: every visible text node of the row's message text, in
 * document order, without separators. Copy buttons and list markers are not message text.
 */
function rowTextNodes(row: HTMLElement): Text[] {
  const nodes: Text[] = [];
  for (const content of row.querySelectorAll<HTMLElement>(MESSAGE_TEXT_SELECTOR)) {
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (node instanceof Text && node.data && !node.parentElement?.closest(IGNORED)) {
        nodes.push(node);
      }
    }
  }
  return nodes;
}

function boundaryOffset(nodes: readonly Text[], container: Node, offset: number): number {
  const lengths = nodes.map((node) => node.data.length);
  const direct = nodes.indexOf(container as Text);
  if (direct >= 0) return joinedOffset(lengths, direct, offset);
  // An element boundary sits before the first text node that follows it.
  const point = document.createRange();
  point.setStart(container, offset);
  const following = nodes.findIndex((node) => point.comparePoint(node, 0) >= 0);
  return joinedOffset(lengths, following < 0 ? nodes.length : following, 0);
}

/** Where a selection lies in one row's text. A range reaching past the row is cut at its end. */
function rangeOffsetsInRow(row: HTMLElement, range: Range): TextSpan | null {
  const nodes = rowTextNodes(row);
  if (nodes.length === 0) return null;
  const startsInside = row.contains(range.startContainer);
  const endsInside = row.contains(range.endContainer);
  const start = startsInside ? boundaryOffset(nodes, range.startContainer, range.startOffset) : 0;
  const end = endsInside
    ? boundaryOffset(nodes, range.endContainer, range.endOffset)
    : joinedOffset(
        nodes.map((node) => node.data.length),
        nodes.length,
        0,
      );
  return end > start ? { start, end } : null;
}

function rangeForSpan(nodes: readonly Text[], span: TextSpan): Range | null {
  const lengths = nodes.map((node) => node.data.length);
  const start = nodeAtOffset(lengths, span.start, "start");
  const end = nodeAtOffset(lengths, span.end, "end");
  if (!start || !end) return null;
  const range = document.createRange();
  range.setStart(nodes[start.index], start.offset);
  range.setEnd(nodes[end.index], end.offset);
  return range;
}

/** A selection rarely runs over more rows than this; the bound keeps a stale note cheap. */
const MAX_QUOTE_ROWS = 24;

/** One paint's view of the mounted chat rows. Each row's text is read at most once. */
export class ChatRowIndex {
  readonly rows: HTMLElement[];
  private readonly texts = new Map<HTMLElement, Text[]>();

  constructor(root: ParentNode) {
    this.rows = Array.from(root.querySelectorAll<HTMLElement>(ROW_SELECTOR));
  }

  nodes(row: HTMLElement): Text[] {
    let nodes = this.texts.get(row);
    if (!nodes) {
      nodes = rowTextNodes(row);
      this.texts.set(row, nodes);
    }
    return nodes;
  }
}

function locateInRows(
  index: ChatRowIndex,
  rows: readonly HTMLElement[],
  quote: string,
  hint?: Partial<TextSpan>,
): Range | null {
  const nodes = rows.flatMap((row) => index.nodes(row));
  const span = locateQuote(nodes.map((node) => node.data).join(""), quote, hint);
  return span ? rangeForSpan(nodes, span) : null;
}

function textLength(nodes: readonly Text[]): number {
  return nodes.reduce((total, node) => total + node.data.length, 0);
}

/**
 * The rendered passage a chat note points at: its own row by offsets, then the quote nearest
 * them. A selection may run on into the message rows below its first one, so those rows are
 * searched with it. A note whose row is not mounted is looked up by quote in every mounted
 * message row. Null while the passage is not mounted.
 */
export function findNoteRange(index: ChatRowIndex, note: Note): Range | null {
  const anchor = note.anchor;
  if (anchor.kind !== "agent" || !note.quote.trim()) return null;
  const { rows } = index;
  let own = anchor.rowId ? rows.findIndex((row) => row.dataset.historyRowId === anchor.rowId) : -1;
  if (own < 0 && anchor.messageId) {
    own = rows.findIndex(
      (row) => row.dataset.messageId === anchor.messageId && chatNoteRow(row) !== null,
    );
  }
  if (own >= 0) {
    const unit = [rows[own]];
    let length = textLength(index.nodes(rows[own]));
    const needed = (anchor.start ?? 0) + note.quote.length;
    for (let next = own + 1; next < rows.length && length < needed; next += 1) {
      // Tool calls between two messages are not message text; a quote skips them too.
      if (!chatNoteRow(rows[next])) continue;
      if (unit.length >= MAX_QUOTE_ROWS) break;
      unit.push(rows[next]);
      length += textLength(index.nodes(rows[next]));
    }
    // A mounted row that no longer holds the quote changed under the note; do not guess.
    return locateInRows(index, unit, note.quote, anchor);
  }
  for (const row of rows) {
    if (!chatNoteRow(row)) continue;
    const range = locateInRows(index, [row], note.quote);
    if (range) return range;
  }
  return null;
}

/**
 * The chat row a selection belongs to: the row holding its start, or the first message row it
 * crosses when it starts between rows.
 */
function selectionRow(rows: readonly HTMLElement[], range: Range): ChatNoteRow | null {
  const startRow = chatNoteRow(rowElementOf(range.startContainer));
  if (startRow) return startRow;
  for (const element of rows) {
    if (!range.intersectsNode(element)) continue;
    const row = chatNoteRow(element);
    if (row) return row;
  }
  return null;
}

/**
 * The selected message text, read from the same text nodes a note's highlight is located in, so
 * list markers, copy buttons and tool calls in between never end up in the quote. Blocks are
 * separated by a line break.
 */
function selectedText(rows: readonly HTMLElement[], range: Range): string {
  let text = "";
  let block: Element | null = null;
  for (const row of rows) {
    if (!range.intersectsNode(row) || !chatNoteRow(row)) continue;
    for (const node of rowTextNodes(row)) {
      if (!range.intersectsNode(node)) continue;
      const start = node === range.startContainer ? range.startOffset : 0;
      const end = node === range.endContainer ? range.endOffset : node.data.length;
      if (end <= start) continue;
      const nodeBlock = node.parentElement?.closest(BLOCK_SELECTOR) ?? row;
      if (block && nodeBlock !== block && !text.endsWith("\n")) text += "\n";
      block = nodeBlock;
      text += node.data.slice(start, end);
    }
  }
  return text.trim();
}

export interface ChatSelection {
  row: ChatNoteRow;
  quote: string;
  span: TextSpan | null;
}

/**
 * What the owner selected in the chat under `root`: the first message row it touches, the
 * offsets in that row, and the selected message text across every row. Null when it holds no
 * message text.
 */
export function readChatSelection(root: HTMLElement, range: Range): ChatSelection | null {
  const rows = Array.from(root.querySelectorAll<HTMLElement>(ROW_SELECTOR));
  const row = selectionRow(rows, range);
  if (!row) return null;
  const quote = selectedText(rows, range);
  if (!quote) return null;
  return { row, quote, span: rangeOffsetsInRow(row.element, range) };
}

/** The row a passage lives in, for scrolling to its message. */
export function noteRangeRow(range: Range): ChatNoteRow | null {
  return chatNoteRow(rowElementOf(range.startContainer));
}
