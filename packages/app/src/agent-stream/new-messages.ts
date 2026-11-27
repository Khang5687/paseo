import { useState } from "react";
import type { StreamItem } from "@/types/stream";

/**
 * Where the reader was when they scrolled up: the last row of the committed timeline, and the
 * rows already streaming in the head. Rows after that point are the ones they have not seen.
 */
export interface SeenMessagesMark {
  lastTailId: string | null;
  headIds: ReadonlySet<string>;
}

export function markSeenMessages(
  tail: readonly StreamItem[],
  head: readonly StreamItem[],
): SeenMessagesMark {
  return {
    lastTailId: tail.at(-1)?.id ?? null,
    headIds: new Set(head.map((item) => item.id)),
  };
}

/**
 * Agent replies that arrived after the mark, for the jump-to-latest arrow's count. Only
 * assistant messages count: a turn of forty tool calls is one thing to read, not forty.
 *
 * The mark is a position, not a set of ids, so older history paged in above the reader does not
 * count as new. A reply moves from the head to the tail when it completes and keeps its id, so it
 * counts once. When the timeline was replaced and the mark's row is gone, only the head counts.
 */
export function countNewMessages(
  mark: SeenMessagesMark,
  tail: readonly StreamItem[],
  head: readonly StreamItem[],
): number {
  const newIds = new Set<string>();
  const markIndex =
    mark.lastTailId === null ? -1 : tail.findIndex((item) => item.id === mark.lastTailId);
  if (mark.lastTailId === null || markIndex !== -1) {
    for (let index = markIndex + 1; index < tail.length; index++) {
      const item = tail[index];
      if (item.kind === "assistant_message" && !mark.headIds.has(item.id)) newIds.add(item.id);
    }
  }
  for (const item of head) {
    if (item.kind === "assistant_message" && !mark.headIds.has(item.id)) newIds.add(item.id);
  }
  return newIds.size;
}

/** Counts new replies from the moment the reader leaves the end until they are back at it. */
export function useNewMessageCount(input: {
  isAtEnd: boolean;
  tail: readonly StreamItem[];
  head: readonly StreamItem[];
}): number {
  const { isAtEnd, tail, head } = input;
  const [mark, setMark] = useState<SeenMessagesMark | null>(null);
  if (isAtEnd && mark !== null) setMark(null);
  if (!isAtEnd && mark === null) setMark(markSeenMessages(tail, head));
  return mark === null ? 0 : countNewMessages(mark, tail, head);
}
