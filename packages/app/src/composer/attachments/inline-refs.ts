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
 * A deletion that falls inside one token (a backspace or delete on a chip, on any keyboard)
 * removes the whole token and its attachment. Every other edit, including select-all + type,
 * paste over, and programmatic replacement, leaves attachments alone: a token that leaves the
 * text only stops naming its attachment, which still sends, labeled, after the text.
 * Returns null when the edit needs no help.
 */
export function reconcileInlineRefEdit(input: {
  previous: string;
  next: string;
  attachments: readonly ComposerAttachment[];
}): { text: string; selection: TextSelection; attachments: ComposerAttachment[] } | null {
  const { previous, next, attachments } = input;
  const labels = inlineRefLabels(attachments);
  if (labels.size === 0 || previous === next) return null;
  const { start, end, inserted } = editRange(previous, next);
  if (inserted !== "") return null;

  const known = new Map<string, number>();
  for (const [index, label] of labels) known.set(label, index);
  const touched = findInlineRefTokens(previous).filter(
    (token) => known.has(token.label) && start < token.end && end > token.start,
  );
  const token = touched.length === 1 ? touched[0]! : null;
  if (!token || start < token.start || end > token.end) return null;

  // Take the space the token was inserted with, so deleting a chip leaves no double space.
  const tokenEnd =
    previous[token.end] === " " && /^$|\s$/.test(previous.slice(0, token.start))
      ? token.end + 1
      : token.end;
  const text = previous.slice(0, token.start) + previous.slice(tokenEnd);
  // A copy of the same token elsewhere keeps naming the attachment.
  if (findInlineRefTokens(text).some((other) => other.label === token.label)) {
    return {
      text,
      selection: { start: token.start, end: token.start },
      attachments: [...attachments],
    };
  }
  const result = removeInlineRefs({
    text,
    attachments,
    removed: new Set([known.get(token.label)!]),
    caret: token.start,
  });
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
