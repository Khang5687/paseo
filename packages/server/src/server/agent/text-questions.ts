import type { AgentOpenQuestion, AgentQuestionAnswer } from "@getpaseo/protocol/messages";
import { parseWithdrawLine } from "@getpaseo/protocol/question-withdraw";

/**
 * Questions agents write in plain reply text, in the grilling format:
 *
 *   ❓ **Q12** - **Strip icons**: round or square?
 *
 *   ➡️ square icons with the project letter
 *
 * The ❓ must start the line, the same contract as `replyAwaitsAnswer`. The label (Q12), the bold
 * title and the ➡️ pick are each optional, so looser variants still become questions.
 */

const QUESTION_MARKER = "❓";
const PICK_MARKER = /^➡\uFE0F?\s*/u;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const LABEL = /^[*_\s]*(Q\d+)\b[*_]*\s*(?:[-–—:.]\s*)?/i;
const PICK_PREFIX = /^(?:\*\*)?(?:my\s+)?(?:pick|recommendation)(?:\*\*)?\s*[:：-]\s*/i;
// A reply never keeps more open questions than this; the oldest go first.
const MAX_OPEN_QUESTIONS = 50;
// Short replies like "gwr" or "yes" answer the questions just asked, as the owner's glossary says.
const BLANKET_ANSWER = /^(?:gwr|yes|yep|yeah|y|ok|okay|sure|go|approved|agreed|lgtm)\b/i;
const BLANKET_ANSWER_MAX_CHARS = 120;
const FOR_ALL = /\bfor all\b/i;
const MENTIONED_LABEL = /\bQ(\d+)\b/gi;

interface ParsedHead {
  label: string | null;
  title: string;
  rest: string;
}

function stripEmphasis(text: string): string {
  return text.replace(/^[*_\s]+|[*_\s]+$/g, "");
}

function parseHead(head: string): ParsedHead {
  let rest = head.trim();
  let label: string | null = null;
  const labelMatch = LABEL.exec(rest);
  if (labelMatch) {
    label = labelMatch[1].toUpperCase();
    rest = rest.slice(labelMatch[0].length);
  }
  if (rest.startsWith("**")) {
    const close = rest.indexOf("**", 2);
    if (close > 2) {
      const title = stripEmphasis(rest.slice(2, close));
      const after = rest.slice(close + 2).replace(/^\s*[:：\-–—]?\s*/, "");
      return { label, title, rest: after };
    }
  }
  const colon = rest.indexOf(":");
  if (colon > 0) {
    return {
      label,
      title: stripEmphasis(rest.slice(0, colon)),
      rest: rest.slice(colon + 1).trim(),
    };
  }
  return { label, title: stripEmphasis(rest), rest: "" };
}

// Where a question's text ends: the next question or a horizontal rule.
function isBoundary(line: string): boolean {
  return line.startsWith(QUESTION_MARKER) || RULE.test(line);
}

/** Every ❓ question in a reply, in order. */
export function parseTextQuestions(
  reply: string | null | undefined,
  askedAt: string,
): AgentOpenQuestion[] {
  if (!reply) return [];
  const lines = reply.split("\n");
  const questions: AgentOpenQuestion[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.startsWith(QUESTION_MARKER)) {
      index += 1;
      continue;
    }
    const head = parseHead(line.slice(QUESTION_MARKER.length));
    index += 1;
    const bodyLines = head.rest ? [head.rest] : [];
    while (
      index < lines.length &&
      !isBoundary(lines[index]) &&
      !PICK_MARKER.test(lines[index].trim())
    ) {
      bodyLines.push(lines[index]);
      index += 1;
    }
    let pick: string | null = null;
    let body: string;
    if (index < lines.length && PICK_MARKER.test(lines[index].trim())) {
      body = bodyLines.join("\n").trim();
      const pickLines = [lines[index].trim().replace(PICK_MARKER, "").replace(PICK_PREFIX, "")];
      index += 1;
      while (index < lines.length && lines[index].trim() !== "" && !isBoundary(lines[index])) {
        pickLines.push(lines[index]);
        index += 1;
      }
      pick = pickLines.join("\n").trim() || null;
    } else {
      // Without a pick nothing marks where the question ends, so only its first paragraph counts:
      // the rest of the reply (Goal, Left to do) is not part of it.
      const start = bodyLines.findIndex((bodyLine) => bodyLine.trim() !== "");
      const rest = start === -1 ? [] : bodyLines.slice(start);
      const end = rest.findIndex((bodyLine) => bodyLine.trim() === "");
      body = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
    }
    if (!head.title && !body) continue;
    const title = head.title || body.split("\n")[0];
    const id = head.label ?? `t:${title.toLowerCase().replace(/\s+/g, " ").slice(0, 80)}`;
    questions.push({ id, label: head.label, title, body, pick, askedAt });
  }
  return questions;
}

/** Adds a reply's questions to the open ones. A question asked again replaces its earlier copy. */
export function mergeAskedQuestions(
  open: readonly AgentOpenQuestion[],
  asked: readonly AgentOpenQuestion[],
): AgentOpenQuestion[] {
  if (asked.length === 0) return [...open];
  const askedIds = new Set(asked.map((question) => question.id));
  const merged = [...open.filter((question) => !askedIds.has(question.id)), ...asked];
  return merged.slice(-MAX_OPEN_QUESTIONS);
}

/**
 * The open questions after one turn-ending reply: its ✖️ lines withdraw the agent's own open
 * questions, then its ❓ questions are added. A label the same reply asks again stays open, since
 * the ❓ is the newer word; an unknown label withdraws nothing.
 */
export function applyReplyQuestions(
  open: readonly AgentOpenQuestion[],
  reply: string | null | undefined,
  askedAt: string,
): AgentOpenQuestion[] {
  const withdrawn = new Set(
    (reply ?? "").split("\n").flatMap((line) => parseWithdrawLine(line)?.label ?? []),
  );
  const kept = withdrawn.size
    ? open.filter((question) => !question.label || !withdrawn.has(question.label))
    : open;
  return mergeAskedQuestions(kept, parseTextQuestions(reply, askedAt));
}

/**
 * The open questions a user message leaves open.
 *
 * - A message that names labels ("Q12 yes", "Q1 a Q2 b") answers those.
 * - A short blanket answer that names none ("gwr", "yes", "ok go") answers the questions from the
 *   latest reply that asked any; "gwr for all" answers every open question.
 * - A question without a label cannot be named, so any message answers it.
 * - Anything else leaves labelled questions open: the user wrote about something else.
 */
export function answerTextQuestions(
  open: readonly AgentOpenQuestion[],
  message: string,
): AgentOpenQuestion[] {
  if (open.length === 0) return [];
  const labelled = open.filter((question) => question.label !== null);
  const named = new Set([...message.matchAll(MENTIONED_LABEL)].map((match) => `Q${match[1]}`));
  if (named.size > 0) {
    return labelled.filter((question) => !named.has(question.label ?? ""));
  }
  const text = message.trim();
  if (text.length > BLANKET_ANSWER_MAX_CHARS || !BLANKET_ANSWER.test(text)) {
    return labelled;
  }
  if (FOR_ALL.test(text)) return [];
  const latest = labelled.reduce(
    (newest, question) => (question.askedAt > newest ? question.askedAt : newest),
    "",
  );
  return labelled.filter((question) => question.askedAt !== latest);
}

/**
 * Saves a half-written answer on one open question. Returns null when the question is not open
 * or a newer answer from another device already won (last write wins on `updatedAt`).
 */
export function setQuestionAnswer(
  open: readonly AgentOpenQuestion[],
  questionId: string,
  answer: AgentQuestionAnswer,
): AgentOpenQuestion[] | null {
  const question = open.find((candidate) => candidate.id === questionId);
  if (!question) return null;
  if (question.answer && question.answer.updatedAt > answer.updatedAt) return null;
  return open.map((candidate) => (candidate === question ? { ...candidate, answer } : candidate));
}
