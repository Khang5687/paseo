import type { ComposerAttachment } from "@/attachments/types";

/**
 * Inline attachment references. A pasted, dropped, or picked image or file puts a
 * `[Image #N]` / `[File #N]` token in the draft text at the caret. N is the attachment's
 * position among the draft's image and file attachments, so the text plus the attachment
 * order carry the whole mapping: drafts, recall, and the queue need nothing extra.
 */

type InlineRefAttachment = Extract<ComposerAttachment, { kind: "image" | "file" }>;

export interface TextSelection {
  start: number;
  end: number;
}

const TOKEN_PATTERN = /\[(Image|File) #(\d+)\]/g;
const TOKEN_WITH_SPACE_PATTERN = /\[(Image|File) #(\d+)\]( ?)/g;

export function isInlineRefAttachment(
  attachment: ComposerAttachment,
): attachment is InlineRefAttachment {
  return attachment.kind === "image" || attachment.kind === "file";
}

/** Stable id of an image or file attachment; null for other kinds. */
export function inlineRefId(attachment: ComposerAttachment): string | null {
  if (attachment.kind === "image") return attachment.metadata.id;
  if (attachment.kind === "file") return attachment.attachment.id;
  return null;
}

function labelFor(attachment: InlineRefAttachment, position: number): string {
  return `${attachment.kind === "image" ? "Image" : "File"} #${position}`;
}

/** Label per attachment index, for the image and file attachments only. */
export function inlineRefLabels(attachments: readonly ComposerAttachment[]): Map<number, string> {
  const labels = new Map<number, string>();
  attachments.forEach((attachment, index) => {
    if (isInlineRefAttachment(attachment)) {
      labels.set(index, labelFor(attachment, labels.size + 1));
    }
  });
  return labels;
}

export function findInlineRefTokens(
  text: string,
): Array<{ label: string; start: number; end: number }> {
  return Array.from(text.matchAll(TOKEN_PATTERN), (match) => ({
    label: `${match[1]} #${match[2]}`,
    start: match.index,
    end: match.index + match[0].length,
  }));
}

/** Insert tokens for newly appended attachments at the caret, space-separated from neighbors. */
export function insertInlineRefTokens(input: {
  text: string;
  selection: TextSelection;
  labels: readonly string[];
}): { text: string; selection: TextSelection } {
  const { text, selection, labels } = input;
  const before = text.slice(0, selection.start);
  const after = text.slice(selection.end);
  const lead = before.length > 0 && !/\s$/.test(before) ? " " : "";
  const inserted = `${lead}${labels.map((label) => `[${label}]`).join(" ")} `;
  const tail = after.startsWith(" ") ? after.slice(1) : after;
  const caret = before.length + inserted.length;
  return { text: `${before}${inserted}${tail}`, selection: { start: caret, end: caret } };
}

/**
 * Renumber tokens after attachments are removed. `removed` are attachment indexes; their
 * tokens are deleted, later tokens shift down.
 */
export function removeInlineRefs(input: {
  text: string;
  attachments: readonly ComposerAttachment[];
  removed: ReadonlySet<number>;
  caret?: number;
}): { text: string; attachments: ComposerAttachment[]; caret: number } {
  const { text, attachments, removed } = input;
  const before = inlineRefLabels(attachments);
  const remaining = attachments.filter((_, index) => !removed.has(index));
  const after = inlineRefLabels(remaining);
  const rename = new Map<string, string | null>();
  let kept = 0;
  attachments.forEach((_, index) => {
    const oldLabel = before.get(index);
    if (removed.has(index)) {
      if (oldLabel) rename.set(oldLabel, null);
      return;
    }
    if (oldLabel) rename.set(oldLabel, after.get(kept) ?? null);
    kept += 1;
  });
  // A removed token takes the space after it when nothing but whitespace precedes it, so
  // removing a chip leaves no double space.
  const rewrite = (segment: string) =>
    segment.replace(
      TOKEN_WITH_SPACE_PATTERN,
      (token, kind: string, number: string, space: string, offset: number) => {
        const label = `${kind} #${number}`;
        if (!rename.has(label)) return token;
        const next = rename.get(label);
        if (next) return `[${next}]${space}`;
        return offset === 0 || /\s/.test(segment[offset - 1]!) ? "" : space;
      },
    );
  const caret = input.caret ?? text.length;
  const head = rewrite(text.slice(0, caret));
  return {
    text: head + rewrite(text.slice(caret)),
    attachments: remaining,
    caret: head.length,
  };
}

/** The span of `previous` an edit replaced, and the text it put there. */
function editRange(
  previous: string,
  next: string,
): { start: number; end: number; inserted: string } {
  let prefix = 0;
  const maxPrefix = Math.min(previous.length, next.length);
  while (prefix < maxPrefix && previous[prefix] === next[prefix]) prefix += 1;
  let suffix = 0;
  const maxSuffix = maxPrefix - prefix;
  while (
    suffix < maxSuffix &&
    previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return {
    start: prefix,
    end: previous.length - suffix,
    inserted: next.slice(prefix, next.length - suffix),
  };
}

/**
 * A user edit that touches part of a token removes the whole token and its attachment, so a
 * single backspace deletes a chip on every keyboard. Returns null when the edit needs no help.
 */
export function reconcileInlineRefEdit(input: {
  previous: string;
  next: string;
  attachments: readonly ComposerAttachment[];
}): { text: string; selection: TextSelection; attachments: ComposerAttachment[] } | null {
  const { previous, next, attachments } = input;
  const labels = inlineRefLabels(attachments);
  if (labels.size === 0 || previous === next) return null;
  const known = new Map<string, number>();
  for (const [index, label] of labels) known.set(label, index);

  const range = editRange(previous, next);
  const { inserted } = range;
  let { start, end } = range;
  const previousTokens = findInlineRefTokens(previous).filter((token) => known.has(token.label));
  let expanded = false;
  for (const token of previousTokens) {
    const touches =
      start === end
        ? start > token.start && start < token.end
        : start < token.end && end > token.start;
    if (touches) {
      start = Math.min(start, token.start);
      end = Math.max(end, token.end);
      expanded = true;
    }
  }
  // Take the space the token was inserted with, so deleting a chip leaves no double space.
  if (
    expanded &&
    inserted === "" &&
    previous[end] === " " &&
    /^$|\s$/.test(previous.slice(0, start))
  ) {
    end += 1;
  }
  const text = previous.slice(0, start) + inserted + previous.slice(end);
  const caret = start + inserted.length;

  const present = new Set(findInlineRefTokens(text).map((token) => token.label));
  const removed = new Set<number>();
  for (const token of previousTokens) {
    if (!present.has(token.label)) removed.add(known.get(token.label)!);
  }
  if (removed.size === 0) {
    if (text === next) return null;
    return { text, selection: { start: caret, end: caret }, attachments: [...attachments] };
  }
  const result = removeInlineRefs({ text, attachments, removed, caret });
  return {
    text: result.text,
    selection: { start: result.caret, end: result.caret },
    attachments: result.attachments,
  };
}

/** An image that fails to encode is dropped from the send, which shifts image indexes. */
export function matchEncodedImageRefs<T extends { imageIndex?: number }>(
  refs: T[] | undefined,
  encodedImages: readonly unknown[] | null | undefined,
  images: readonly unknown[] | null | undefined,
): T[] | undefined {
  if (!refs || (encodedImages?.length ?? 0) === (images?.length ?? 0)) return refs;
  return refs.filter((ref) => ref.imageIndex === undefined);
}
