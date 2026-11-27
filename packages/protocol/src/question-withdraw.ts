/**
 * An agent takes back one of its own open questions with a reply line that starts with ✖️:
 *
 *   ✖️ Q630 → Q653: folded into "When the pause ends"
 *   ✖️ Q640: dropped, no longer needed
 *
 * The daemon closes the question (`features.questionWithdraw`); the app shows the line as one
 * small gray line. Same line-start contract as the ❓ that asks a question: a ✖️ after a bullet,
 * indent or quote is prose.
 */

/** A question an agent takes back. */
export interface WithdrawnQuestion {
  label: string;
  /** The question that replaces it, when the agent folded it into another one. */
  replacedBy: string | null;
}

// The arrow part is optional and the labels may be bold. The variation selector is optional, like
// the ➡️ pick marker's.
const WITHDRAW_LINE =
  /^\u2716\uFE0F?[*_\s]*(Q\d+)\b[*_]*(?:\s*(?:→|->|=>)\s*[*_]*(Q\d+)\b[*_]*)?/iu;

/** One ✖️ line, or null. */
export function parseWithdrawLine(line: string): WithdrawnQuestion | null {
  const match = WITHDRAW_LINE.exec(line);
  if (!match) return null;
  return { label: match[1].toUpperCase(), replacedBy: match[2]?.toUpperCase() ?? null };
}
