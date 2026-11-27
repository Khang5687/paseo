import { parseWithdrawLine, type WithdrawnQuestion } from "@getpaseo/protocol/question-withdraw";
import type { StreamItem } from "@/types/stream";

export type ReplySegment =
  | { kind: "markdown"; text: string }
  | { kind: "withdrawn"; questions: WithdrawnQuestion[] };

const FENCE = /^\s{0,3}(```|~~~)/;

/**
 * Splits a reply into Markdown and its ✖️ lines, which the chat shows as small gray lines
 * ("Q630 withdrawn → Q653"). A ✖️ inside a code fence stays code. While the reply streams, its
 * last line may still be growing ("✖️ Q6"), so it stays Markdown until the next line starts.
 * Returns one Markdown segment when the reply has no ✖️ line.
 */
export function splitWithdrawnLines(text: string, streaming: boolean): ReplySegment[] {
  if (!text.includes("\u2716")) return [{ kind: "markdown", text }];
  const lines = text.split("\n");
  const complete = streaming ? lines.length - 1 : lines.length;
  const segments: ReplySegment[] = [];
  let markdown: string[] = [];
  let fence: string | null = null;
  const flushMarkdown = () => {
    const joined = markdown.join("\n").replace(/^\n+|\n+$/g, "");
    if (joined.trim()) segments.push({ kind: "markdown", text: joined });
    markdown = [];
  };
  lines.forEach((line, index) => {
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1];
      else if (fence === fenceMatch[1]) fence = null;
    }
    const withdrawn = fence === null && index < complete ? parseWithdrawLine(line) : null;
    if (!withdrawn) {
      markdown.push(line);
      return;
    }
    flushMarkdown();
    const last = segments.at(-1);
    // A label repeated in one group says nothing new, and the group keys its lines by label.
    if (last?.kind !== "withdrawn") segments.push({ kind: "withdrawn", questions: [withdrawn] });
    else if (!last.questions.some((question) => question.label === withdrawn.label)) {
      last.questions.push(withdrawn);
    }
  });
  flushMarkdown();
  return segments.length > 0 ? segments : [{ kind: "markdown", text }];
}

/**
 * The newest loaded reply that asks `label` with a ❓ line, or null. `items` may hold the tail
 * and the head in any order; the latest timestamp wins, since a question asked again replaces
 * its earlier copy.
 */
export function findQuestionMessageId(items: readonly StreamItem[], label: string): string | null {
  const asks = new RegExp(`^❓[*_\\s]*${label}\\b`, "im");
  let found: { id: string; at: number } | null = null;
  for (const item of items) {
    if (item.kind !== "assistant_message" || !asks.test(item.text)) continue;
    const at = item.timestamp.getTime();
    if (!found || at >= found.at) found = { id: item.id, at };
  }
  return found?.id ?? null;
}
