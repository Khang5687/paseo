import type { AgentPermissionRequest } from "../../agent/agent-sdk-types.js";

/**
 * Speaking and answering the agent's question cards by voice. The card's shape matches what
 * the app renders (`question-form-card-core.ts`): each question has a `header` that keys the
 * answer, optional options, and flags for multi-select and free text.
 */

export interface SpokenQuestion {
  question: string;
  header: string;
  options: string[];
  multiSelect: boolean;
  allowOther: boolean;
}

export type SpokenAnswer =
  | { kind: "answer"; answer: string }
  | { kind: "dismiss" }
  | { kind: "repeat" }
  | { kind: "unclear" };

export function parseSpokenQuestions(input: unknown): SpokenQuestion[] | null {
  if (typeof input !== "object" || input === null) {
    return null;
  }
  const raw = (input as Record<string, unknown>).questions;
  if (!Array.isArray(raw)) {
    return null;
  }
  const questions: SpokenQuestion[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) {
      return null;
    }
    const entry = item as Record<string, unknown>;
    if (typeof entry.question !== "string" || typeof entry.header !== "string") {
      return null;
    }
    if (!Array.isArray(entry.options)) {
      return null;
    }
    const options: string[] = [];
    for (const option of entry.options as unknown[]) {
      if (typeof option !== "object" || option === null) {
        return null;
      }
      const label = (option as Record<string, unknown>).label;
      if (typeof label !== "string") {
        return null;
      }
      options.push(label);
    }
    questions.push({
      question: entry.question,
      header: entry.header,
      options,
      multiSelect: entry.multiSelect === true,
      allowOther: entry.allowOther === true || entry.isOther === true,
    });
  }
  return questions.length > 0 ? questions : null;
}

/** The question exactly as written, then its option labels. A card with several questions is read one at a time. */
export function buildQuestionSpeech(
  question: SpokenQuestion,
  position: { index: number; total: number },
): string {
  const parts: string[] = [];
  if (position.total > 1) {
    parts.push(`Question ${position.index + 1} of ${position.total}.`);
  }
  parts.push(question.question.trim());
  if (question.options.length > 0) {
    parts.push(`Options: ${question.options.map((label) => label.trim()).join(". ")}.`);
    if (question.multiSelect) {
      parts.push("You can pick more than one.");
    }
  }
  return parts.join(" ");
}

export function buildUnclearAnswerSpeech(question: SpokenQuestion): string {
  return `Sorry, I did not catch which option. Options: ${question.options.join(". ")}. Say repeat, or say dismiss to skip.`;
}

/** A permission prompt, as written by the provider. Voice never answers it; the listener does on screen. */
export function buildPermissionSpeech(request: AgentPermissionRequest): string {
  const title = request.title?.trim() || `Allow tool: ${request.name}`;
  const description = request.description?.trim();
  return ["Permission needed.", title, description, "Answer it on screen."]
    .filter((part): part is string => Boolean(part))
    .join(" ");
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/['\u2019]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const ORDINALS: Record<string, number> = {
  first: 0,
  "1st": 0,
  one: 0,
  "1": 0,
  second: 1,
  "2nd": 1,
  two: 1,
  "2": 1,
  third: 2,
  "3rd": 2,
  three: 2,
  "3": 2,
  fourth: 3,
  "4th": 3,
  four: 3,
  "4": 3,
  fifth: 4,
  "5th": 4,
  five: 4,
  "5": 4,
  sixth: 5,
  "6th": 5,
  six: 5,
  "6": 5,
};

const ORDINAL_UTTERANCE =
  /^(?:(?:the|option|number|choice|answer|pick|choose|select|go with|i ll take|ill take|take) )*(first|1st|one|1|second|2nd|two|2|third|3rd|three|3|fourth|4th|four|4|fifth|5th|five|5|sixth|6th|six|6)(?: one| option)?$/;

const FILLER_WORDS = new Set([
  "i",
  "id",
  "ill",
  "go",
  "with",
  "take",
  "choose",
  "pick",
  "select",
  "the",
  "please",
  "lets",
  "let",
  "us",
  "want",
  "would",
  "like",
  "to",
  "prefer",
  "option",
  "answer",
]);

const DISMISS_UTTERANCE =
  /^(?:please )?(?:dismiss(?: it| this| the question)?|cancel(?: it| this)?|skip(?: it| this| the question)?|never ?mind|forget it)$/;
const REPEAT_UTTERANCE =
  /^(?:please )?(?:repeat(?: that| it| the question)?|say (?:that|it) again|read (?:that|it|the question) again|(?:whats|what is|what was) the question)$/;

function containsPhrase(haystack: string, phrase: string): boolean {
  return phrase.length > 0 && ` ${haystack} `.includes(` ${phrase} `);
}

function matchOptions(options: string[], spoken: string): number[] {
  const labels = options.map(normalize);

  const ordinal = ORDINAL_UTTERANCE.exec(spoken);
  if (ordinal) {
    const index = ORDINALS[ordinal[1]];
    if (index !== undefined && index < options.length) {
      return [index];
    }
  }

  // A one- or two-letter label ("A", "B") would match inside any sentence; it must be the whole reply.
  const named = labels.flatMap((label, index) => {
    if (label.length < 3) {
      return label === spoken ? [index] : [];
    }
    return containsPhrase(spoken, label) ? [index] : [];
  });
  // "Yes, and add tests" and "Yes" both match "yes, and add tests": keep the longest.
  const specific = named.filter(
    (index) =>
      !named.some(
        (other) =>
          other !== index &&
          labels[other] !== labels[index] &&
          labels[other].includes(labels[index]),
      ),
  );
  if (specific.length > 0) {
    return specific;
  }

  // "go with redis" for the option "Use Redis for caching": every content word sits in one label.
  const content = spoken.split(" ").filter((word) => word.length > 0 && !FILLER_WORDS.has(word));
  if (content.length === 0) {
    return [];
  }
  const partial = labels.flatMap((label, index) => {
    const words = new Set(label.split(" "));
    return content.every((word) => words.has(word)) ? [index] : [];
  });
  return partial.length === 1 ? partial : [];
}

/**
 * Reads a transcribed reply as the answer to one question. A reply that names exactly one option
 * (or several for multi-select) picks it; otherwise it is the typed answer when the card takes
 * free text, and unclear when it does not.
 */
export function interpretSpokenAnswer(question: SpokenQuestion, transcript: string): SpokenAnswer {
  const spoken = normalize(transcript);
  const raw = transcript.trim();
  if (!spoken) {
    return { kind: "unclear" };
  }

  const matched = matchOptions(question.options, spoken);
  if (matched.length === 1 || (matched.length > 1 && question.multiSelect)) {
    return { kind: "answer", answer: matched.map((index) => question.options[index]).join(", ") };
  }

  if (matched.length === 0) {
    if (REPEAT_UTTERANCE.test(spoken)) {
      return { kind: "repeat" };
    }
    if (DISMISS_UTTERANCE.test(spoken)) {
      return { kind: "dismiss" };
    }
  }

  if (question.options.length === 0 || question.allowOther) {
    return { kind: "answer", answer: raw };
  }
  return { kind: "unclear" };
}
