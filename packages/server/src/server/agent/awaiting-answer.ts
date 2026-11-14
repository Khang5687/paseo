const QUESTION_MARKER = "❓";

/**
 * Whether a finished reply leaves the user a question to answer: some line of it starts with "❓".
 *
 * The marker is the whole contract. A "?" anywhere, or a ❓ after other text on the same line
 * (indent, list bullet, quote), does not count, so ordinary prose never parks an agent in
 * needs-input.
 */
export function replyAwaitsAnswer(reply: string | null | undefined): boolean {
  if (!reply) {
    return false;
  }
  return reply.split("\n").some((line) => line.startsWith(QUESTION_MARKER));
}
