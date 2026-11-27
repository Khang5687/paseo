import type {
  AgentPermissionDraft,
  AgentPermissionDraftFile,
} from "@getpaseo/protocol/agent-types";

export interface QuestionOption {
  label: string;
  description?: string;
  preview?: string;
}

export interface QuestionFormQuestion {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
  allowOther: boolean;
  allowEmpty: boolean;
  placeholder?: string;
  dismissLabel?: string;
}

export type QuestionSelections = Record<number, ReadonlySet<number>>;
export type QuestionOtherTexts = Record<number, string>;

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

export function parseQuestionFormQuestions(input: unknown): QuestionFormQuestion[] | null {
  if (
    typeof input !== "object" ||
    input === null ||
    !("questions" in input) ||
    !Array.isArray((input as Record<string, unknown>).questions)
  ) {
    return null;
  }
  const raw = (input as Record<string, unknown>).questions as unknown[];
  const questions: QuestionFormQuestion[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return null;
    const q = item as Record<string, unknown>;
    if (typeof q.question !== "string" || typeof q.header !== "string") return null;
    if (!Array.isArray(q.options)) return null;
    const options: QuestionOption[] = [];
    for (const opt of q.options as unknown[]) {
      if (typeof opt !== "object" || opt === null) return null;
      const o = opt as Record<string, unknown>;
      if (typeof o.label !== "string") return null;
      options.push({
        label: o.label,
        description: typeof o.description === "string" ? o.description : undefined,
        preview: readOptionalString(o, "preview"),
      });
    }
    questions.push({
      question: q.question,
      header: q.header,
      options,
      multiSelect: q.multiSelect === true,
      allowOther: q.allowOther === true || q.isOther === true,
      allowEmpty: q.allowEmpty === true,
      placeholder: readOptionalString(q, "placeholder"),
      dismissLabel: readOptionalString(q, "dismissLabel"),
    });
  }
  return questions.length > 0 ? questions : null;
}

export function questionShowsTextInput(question: QuestionFormQuestion): boolean {
  return question.options.length === 0 || question.allowOther;
}

export function isQuestionAnswered(
  question: QuestionFormQuestion,
  qIndex: number,
  selections: QuestionSelections,
  otherTexts: QuestionOtherTexts,
): boolean {
  const selected = selections[qIndex];
  if (selected && selected.size > 0) {
    return true;
  }

  if (!questionShowsTextInput(question)) {
    return false;
  }

  const otherText = otherTexts[qIndex]?.trim();
  if (otherText && otherText.length > 0) {
    return true;
  }

  return question.allowEmpty;
}

export function areQuestionsAnswered(
  questions: QuestionFormQuestion[] | null,
  selections: QuestionSelections,
  otherTexts: QuestionOtherTexts,
): boolean {
  return (
    questions?.every((question, qIndex) =>
      isQuestionAnswered(question, qIndex, selections, otherTexts),
    ) ?? false
  );
}

/**
 * One list per answered question: the checked option labels in option order, then the
 * trimmed Other text. Providers read these instead of splitting the joined `answers`
 * strings, which corrupts any label or custom answer that contains a comma.
 */
export function buildQuestionFormAnswerLists(
  questions: QuestionFormQuestion[],
  selections: QuestionSelections,
  otherTexts: QuestionOtherTexts,
  extras: QuestionFormAnswerExtras = {},
): Record<string, string[]> {
  const answerLists: Record<string, string[]> = {};
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const selected = selections[i];
    const otherText = otherTexts[i]?.trim();
    const labels = q.options
      .filter((_, idx) => selected?.has(idx) === true)
      .map((option) => option.label);

    if (questionShowsTextInput(q)) {
      if (otherText && otherText.length > 0) {
        // Multi-select keeps the checked options and appends the custom answer, the way
        // Claude Code's own AskUserQuestion UI does. Single-select replaces the option.
        answerLists[q.header] = q.multiSelect ? [...labels, otherText] : [otherText];
        continue;
      }
      if (q.allowEmpty && q.options.length === 0) {
        answerLists[q.header] = [];
        continue;
      }
    }

    if (labels.length > 0) {
      answerLists[q.header] = labels;
    }
  }
  return withAnswerExtras(questions, answerLists, extras);
}

/** The comma-joined answer per question: Claude Code's native format, and the only one older daemons read. */
export function buildQuestionFormAnswers(
  questions: QuestionFormQuestion[],
  selections: QuestionSelections,
  otherTexts: QuestionOtherTexts,
  extras?: QuestionFormAnswerExtras,
): Record<string, string> {
  const answerLists = buildQuestionFormAnswerLists(questions, selections, otherTexts, extras);
  return Object.fromEntries(
    Object.entries(answerLists).map(([header, answers]) => [header, answers.join(", ")]),
  );
}

/** Sent for a question "Send what I have" leaves open (owner decision Q105). */
export const NO_ANSWER_YET = "No answer yet: use your pick or ask me again";

export type QuestionFiles = Record<number, readonly AgentPermissionDraftFile[]>;

export interface QuestionFormAnswerExtras {
  /** Uploaded files per question; their host paths join that question's answer. */
  files?: QuestionFiles;
  /** Answers every question left open with this text, for "Send what I have". */
  fillUnanswered?: string;
}

function withAnswerExtras(
  questions: QuestionFormQuestion[],
  answerLists: Record<string, string[]>,
  { files, fillUnanswered }: QuestionFormAnswerExtras,
): Record<string, string[]> {
  if (!files && !fillUnanswered) return answerLists;
  const next = { ...answerLists };
  questions.forEach((question, index) => {
    const paths = files?.[index]?.map((file) => file.path) ?? [];
    const current = next[question.header];
    if (paths.length > 0) {
      next[question.header] = [...(current ?? []), `Files: ${paths.join(", ")}`];
    } else if (current === undefined && fillUnanswered) {
      next[question.header] = [fillUnanswered];
    }
  });
  return next;
}

/** The box's state as a draft every device can show. */
export function draftFromQuestionForm(input: {
  selections: QuestionSelections;
  otherTexts: QuestionOtherTexts;
  files: QuestionFiles;
  updatedAt: number;
}): AgentPermissionDraft {
  const indexes = new Set([
    ...Object.keys(input.selections),
    ...Object.keys(input.otherTexts),
    ...Object.keys(input.files),
  ]);
  const answers: AgentPermissionDraft["answers"] = {};
  for (const key of indexes) {
    const index = Number(key);
    answers[key] = {
      selected: [...(input.selections[index] ?? [])].sort((a, b) => a - b),
      text: input.otherTexts[index] ?? "",
      files: [...(input.files[index] ?? [])],
    };
  }
  return { answers, updatedAt: input.updatedAt };
}

/** A question box's picks, typed words and files, by question index. */
export interface QuestionFormDraftState {
  selections: Record<number, Set<number>>;
  otherTexts: QuestionOtherTexts;
  files: QuestionFiles;
}

/** A draft from the host back into the box's state. */
export function questionFormFromDraft(
  draft: AgentPermissionDraft | undefined,
): QuestionFormDraftState {
  const selections: Record<number, Set<number>> = {};
  const otherTexts: QuestionOtherTexts = {};
  const files: QuestionFiles = {};
  for (const [key, answer] of Object.entries(draft?.answers ?? {})) {
    const index = Number(key);
    if (answer.selected.length > 0) selections[index] = new Set(answer.selected);
    if (answer.text) otherTexts[index] = answer.text;
    if (answer.files.length > 0) files[index] = answer.files;
  }
  return { selections, otherTexts, files };
}

export function shouldSubmitEmptyOnDismiss(questions: QuestionFormQuestion[]): boolean {
  return (
    questions.length > 0 &&
    questions.every((question) => question.allowEmpty && question.options.length === 0)
  );
}

// One question that takes exactly one listed option and nothing typed is answered by the
// tap itself: each option becomes a button that submits. Option descriptions and previews keep
// the form, because a button has room for a label only.
export function isOneTapQuestion(questions: QuestionFormQuestion[]): boolean {
  if (questions.length !== 1) return false;
  const [question] = questions;
  return (
    !question.multiSelect &&
    !questionShowsTextInput(question) &&
    question.options.every((option) => !option.description?.trim() && !option.preview?.trim())
  );
}

export function resolveDismissLabel(
  questions: QuestionFormQuestion[],
  fallbackLabel = "Dismiss",
): string {
  return questions.find((question) => question.dismissLabel)?.dismissLabel ?? fallbackLabel;
}
