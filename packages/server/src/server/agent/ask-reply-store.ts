import { randomUUID } from "node:crypto";
import type { AgentAskReplyInfo } from "@getpaseo/protocol/messages";

/** A saved answer stays readable this long after it completes, whatever happens to its thread. */
export const REPLY_RETENTION_MS = 30 * 60_000;
export const DEFAULT_REPLY_STORE_CHARS = 2_000_000;

/** A page break is moved back to a paragraph or heading only within this share of the page. */
const BREAK_WINDOW = 0.4;

export const REPLY_GONE_MESSAGE =
  "That reply is no longer stored (expired or the host restarted). Ask again if you still need it.";

export interface StoredReply {
  readonly replyId: string;
  readonly ownerKey: string;
  readonly agentId: string;
  readonly round: number;
  readonly text: string;
  /** Page start offsets (UTF-16 indexes into `text`), frozen when the reply is stored. */
  readonly starts: readonly number[];
  readonly totalChars: number;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/** UTF-16 index after `count` code points from `from`, or the end of the text. */
function advanceCodePoints(text: string, from: number, count: number): number {
  let index = from;
  for (let left = count; left > 0 && index < text.length; left -= 1) {
    const code = text.charCodeAt(index);
    const isPair =
      code >= 0xd800 &&
      code <= 0xdbff &&
      index + 1 < text.length &&
      text.charCodeAt(index + 1) >= 0xdc00 &&
      text.charCodeAt(index + 1) <= 0xdfff;
    index += isPair ? 2 : 1;
  }
  return index;
}

export function countCodePoints(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; count += 1) {
    index = advanceCodePoints(text, index, 1);
  }
  return count;
}

/**
 * Start offsets of each page. A page holds at most `pageSize` code points. Within the last 40% of
 * a full page the break goes to the latest paragraph break or markdown heading, else the latest
 * line break; with none of those it cuts on a code point. Pages joined give the text back exactly.
 */
export function paginate(text: string, pageSize: number): number[] {
  const size = Math.max(1, Math.floor(pageSize));
  const starts = [0];
  let start = 0;
  for (;;) {
    const end = advanceCodePoints(text, start, size);
    if (end >= text.length) return starts;
    const windowFrom = advanceCodePoints(text, start, size - Math.floor(size * BREAK_WINDOW));
    const tail = text.slice(windowFrom, end);
    let cut = -1;
    for (const match of tail.matchAll(/\n(?:[ \t]*\r?\n)+/g)) {
      cut = Math.max(cut, windowFrom + match.index + match[0].length);
    }
    for (const match of tail.matchAll(/\n(?=#{1,6}[ \t])/g)) {
      cut = Math.max(cut, windowFrom + match.index + 1);
    }
    if (cut <= start) {
      const lineBreak = tail.lastIndexOf("\n");
      cut = lineBreak >= 0 ? windowFrom + lineBreak + 1 : -1;
    }
    start = cut > start ? cut : end;
    starts.push(start);
  }
}

export function encodeCursor(replyId: string, page: number): string {
  return Buffer.from(JSON.stringify([replyId, page])).toString("base64url");
}

function decodeCursor(cursor: string): { replyId: string; page: number } | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      Array.isArray(parsed) &&
      typeof parsed[0] === "string" &&
      Number.isInteger(parsed[1]) &&
      (parsed[1] as number) >= 1
    ) {
      return { replyId: parsed[0], page: parsed[1] as number };
    }
  } catch {
    // Falls through: a malformed cursor is the same as an unknown one.
  }
  return null;
}

/**
 * Full ask_agent answers, in memory, so a long one is read in pages without asking the copy
 * again. Records are immutable and expire a fixed time after they were made; reads never extend
 * that. Expiry is lazy: expired records are dropped on the next save or read, so memory is held
 * until then (bounded by the cap). The cap counts code points, like `totalChars`; when the
 * stored text passes it, the oldest records go first.
 *
 * `ownerKey` keeps one asker's cursors from working for another. For an agent it is the agent
 * id; for a WebSocket client it is the connection's client id, which the client chooses, so it
 * is not a security boundary against a client that can claim any id.
 */
export class AskReplyStore {
  private readonly replies = new Map<string, StoredReply>();
  private storedChars = 0;

  constructor(
    private readonly options: {
      maxChars: number;
      retentionMs?: number;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /**
   * Save a finished answer. Returns null when it alone is bigger than the whole store, in which
   * case nothing is saved.
   */
  save(input: {
    ownerKey: string;
    agentId: string;
    round: number;
    text: string;
    /** Page boundaries from `paginate`. */
    starts: readonly number[];
  }): StoredReply | null {
    this.sweep();
    const totalChars = countCodePoints(input.text);
    if (totalChars > this.options.maxChars) return null;
    while (this.storedChars + totalChars > this.options.maxChars) {
      const oldest = this.replies.values().next().value;
      if (!oldest) break;
      this.drop(oldest);
    }
    const createdAt = this.now();
    const record: StoredReply = {
      replyId: randomUUID(),
      ownerKey: input.ownerKey,
      agentId: input.agentId,
      round: input.round,
      text: input.text,
      starts: input.starts,
      totalChars,
      createdAt,
      expiresAt: createdAt + (this.options.retentionMs ?? REPLY_RETENTION_MS),
    };
    this.replies.set(record.replyId, record);
    this.storedChars += totalChars;
    return record;
  }

  /** The page's text and info, for the owner asking about the same agent. */
  page(record: StoredReply, page: number): { text: string; reply: AgentAskReplyInfo } {
    const pages = record.starts.length;
    const from = record.starts[page - 1] ?? 0;
    const to = record.starts[page] ?? record.text.length;
    return {
      text: record.text.slice(from, to),
      reply: {
        replyId: record.replyId,
        round: record.round,
        page,
        pages,
        totalChars: record.totalChars,
        expiresAt: new Date(record.expiresAt).toISOString(),
        nextCursor: page < pages ? encodeCursor(record.replyId, page + 1) : null,
      },
    };
  }

  read(
    cursor: string,
    ownerKey: string,
    agentId: string,
  ): { text: string; reply: AgentAskReplyInfo } {
    this.sweep();
    const decoded = decodeCursor(cursor);
    const record = decoded ? this.replies.get(decoded.replyId) : undefined;
    // A wrong owner or agent gets the same answer as a missing reply: no hint that it exists.
    if (
      !decoded ||
      !record ||
      decoded.page > record.starts.length ||
      !ownerKey ||
      record.ownerKey !== ownerKey ||
      record.agentId !== agentId
    ) {
      throw new Error(REPLY_GONE_MESSAGE);
    }
    return this.page(record, decoded.page);
  }

  private sweep(): void {
    const now = this.now();
    for (const record of this.replies.values()) {
      if (record.expiresAt > now) break;
      this.drop(record);
    }
  }

  private drop(record: StoredReply): void {
    this.replies.delete(record.replyId);
    this.storedChars -= record.totalChars;
  }
}
