import type {
  AgentOpenQuestion,
  AgentQuestionAnswer,
  AgentQuestionAnswerFile,
} from "@getpaseo/protocol/messages";

/** Files one answer may carry (owner decision Q105). */
export const MAX_ANSWER_FILES = 100;

export function isQuestionAnswered(answer: AgentQuestionAnswer | undefined): boolean {
  return Boolean(answer && (answer.pick || answer.text.trim().length > 0));
}

/**
 * The line that answers one question. It names the label and title so the agent cannot mix up
 * which question it answers, and a pick carries the pick's own words, because "yes" alone means
 * nothing once the reply that asked has scrolled out of the agent's context. The words are fixed
 * English: agents read them (and the daemon matches the label), so they are not translated.
 */
export function formatAnswerLine(question: AgentOpenQuestion, answer: AgentQuestionAnswer): string {
  const head = question.label ? `${question.label} (${question.title})` : `(${question.title})`;
  const files = answer.files?.length
    ? ` [files: ${answer.files.map((file) => file.fileName).join(", ")}]`
    : "";
  return `${head} ${answerBody(question, answer)}${files}`;
}

function answerBody(question: AgentOpenQuestion, answer: AgentQuestionAnswer): string {
  if (!answer.pick) return answer.text.trim();
  return question.pick ? `yes: ${question.pick}` : "yes";
}

export interface AnswerMessage {
  text: string;
  files: AgentQuestionAnswerFile[];
  /** Questions this message answers; the rest stay open. */
  questionIds: string[];
}

/** One message for every answered question, in the order the agent asked them. */
export function buildAnswerMessage(
  questions: readonly AgentOpenQuestion[],
  answerFor: (question: AgentOpenQuestion) => AgentQuestionAnswer | undefined,
): AnswerMessage | null {
  const lines: string[] = [];
  const files: AgentQuestionAnswerFile[] = [];
  const questionIds: string[] = [];
  for (const question of questions) {
    const answer = answerFor(question);
    if (!answer || !isQuestionAnswered(answer)) continue;
    lines.push(formatAnswerLine(question, answer));
    files.push(...(answer.files ?? []));
    questionIds.push(question.id);
  }
  if (lines.length === 0) return null;
  return { text: lines.join("\n"), files, questionIds };
}

/** The newer of this device's answer and the one the host keeps; last write wins. */
export function resolveAnswer(
  local: AgentQuestionAnswer | undefined,
  remote: AgentQuestionAnswer | undefined,
): AgentQuestionAnswer | undefined {
  if (!local) return remote;
  if (!remote) return local;
  return remote.updatedAt > local.updatedAt ? remote : local;
}
