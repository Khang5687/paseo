import { noteFired, noteState, type Note } from "@/notes/model";

/** Character offsets into a chat row's rendered text, end exclusive. */
export interface TextSpan {
  start: number;
  end: number;
}

const WHITESPACE = /\s+/g;
const REGEXP_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/**
 * Find the quote inside a row's text. The stored offsets win when they still cover the quote;
 * otherwise the occurrence nearest the stored start does, so an edited or re-rendered row keeps
 * pointing at the passage the owner chose.
 */
export function locateQuote(
  text: string,
  quote: string,
  hint?: Partial<TextSpan> | null,
): TextSpan | null {
  const start = hint?.start;
  const end = hint?.end;
  if (
    start !== undefined &&
    end !== undefined &&
    start >= 0 &&
    end > start &&
    end <= text.length &&
    text.slice(start, end).replace(WHITESPACE, "") === quote.replace(WHITESPACE, "")
  ) {
    return { start, end };
  }
  // The rendered text of a row is its text nodes joined without separators, so block breaks and
  // soft wraps may or may not appear as whitespace. Quotes come from a selection, which inserts
  // them, so a whitespace run in the quote matches optional whitespace in the text.
  const tokens = quote.trim().split(WHITESPACE).filter(Boolean);
  if (tokens.length === 0) return null;
  const pattern = new RegExp(
    tokens.map((token) => token.replace(REGEXP_SPECIAL, "\\$&")).join("\\s*"),
    "gu",
  );
  let best: TextSpan | null = null;
  for (const match of text.matchAll(pattern)) {
    const candidate = { start: match.index, end: match.index + match[0].length };
    if (start === undefined) return candidate;
    if (!best || Math.abs(candidate.start - start) < Math.abs(best.start - start)) {
      best = candidate;
    }
  }
  return best;
}

/**
 * A row's text is a sequence of text nodes. A boundary point is a node index and an offset in it;
 * this turns it into an offset into the joined text. Indices past the end clamp to the end.
 */
export function joinedOffset(lengths: readonly number[], index: number, offset: number): number {
  let total = 0;
  for (let i = 0; i < lengths.length; i += 1) {
    if (i === index) return total + Math.min(Math.max(offset, 0), lengths[i]);
    total += lengths[i];
  }
  return total;
}

/** The node index and local offset of a joined-text offset; the inverse of `joinedOffset`. */
export function nodeAtOffset(
  lengths: readonly number[],
  offset: number,
  affinity: "start" | "end",
): { index: number; offset: number } | null {
  let total = 0;
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index];
    const inside = affinity === "start" ? offset < total + length : offset <= total + length;
    if (inside && offset >= total) return { index, offset: offset - total };
    total += length;
  }
  return null;
}

/**
 * Chat find needs a short, single-block query: its host search matches inside one message
 * block, so a quote spanning paragraphs is cut to its first line.
 */
export function noteFindQuery(quote: string, maxLength = 80): string {
  const line =
    quote
      .split("\n")
      .map((part) => part.trim())
      .find((part) => part.length > 0) ?? "";
  if (line.length <= maxLength) return line;
  const cut = line.slice(0, maxLength);
  const space = cut.lastIndexOf(" ");
  return space > maxLength / 2 ? cut.slice(0, space) : cut;
}

/** Waiting and open notes share one tint; resolved notes are drawn done, green when fired. */
export type ChatNoteHighlightKind = "open" | "fired" | "resolved";

export function chatNoteHighlightKind(note: Note): ChatNoteHighlightKind {
  if (noteState(note) !== "resolved") return "open";
  return noteFired(note) ? "fired" : "resolved";
}
