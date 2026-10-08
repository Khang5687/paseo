import { describe, expect, test } from "vitest";
import {
  areQuestionsAnswered,
  buildQuestionFormAnswers,
  buildQuestionFormNotes,
  parseQuestionFormQuestions,
  questionPickAdvances,
  questionPickReplacesText,
  questionShowsTextInput,
  resolveDismissLabel,
  resolveQuestionTextRole,
  shouldSubmitEmptyOnDismiss,
  type QuestionFormQuestion,
  type QuestionSelections,
} from "./question-form-card-core";

function parseQuestions(question: Record<string, unknown>): QuestionFormQuestion[] {
  const questions = parseQuestionFormQuestions({ questions: [question] });
  if (!questions) throw new Error("questions did not parse");
  return questions;
}

describe("question form card core", () => {
  test("treats optional input prompts as skippable empty answers", () => {
    const questions = parseQuestionFormQuestions({
      questions: [
        {
          question: "Optional comment?",
          header: "Response",
          options: [],
          multiSelect: false,
          placeholder: "Optional comment (press Enter to skip)...",
          allowEmpty: true,
          dismissLabel: "Skip",
        },
      ],
    });

    if (!questions) throw new Error("questions did not parse");
    expect(areQuestionsAnswered(questions, {}, {})).toBe(true);
    expect(buildQuestionFormAnswers(questions, {}, {})).toEqual({ Response: "" });
    expect(shouldSubmitEmptyOnDismiss(questions)).toBe(true);
    expect(resolveDismissLabel(questions)).toBe("Skip");
  });

  test("requires a selection for option-only questions", () => {
    const questions = parseQuestionFormQuestions({
      questions: [
        {
          question: "Pick one",
          header: "Response",
          options: [{ label: "A" }, { label: "B" }],
          multiSelect: false,
        },
      ],
    });

    if (!questions) throw new Error("questions did not parse");
    const [question] = questions;
    if (!question) throw new Error("question missing");
    expect(questionShowsTextInput(question)).toBe(false);
    expect(areQuestionsAnswered(questions, {}, { 0: "freeform" })).toBe(false);
    expect(areQuestionsAnswered(questions, { 0: new Set([1]) }, {})).toBe(true);
    expect(buildQuestionFormAnswers(questions, { 0: new Set([1]) }, {})).toEqual({
      Response: "B",
    });
  });

  test("keeps checked options and appends the other answer for multi-select", () => {
    const questions = parseQuestionFormQuestions({
      questions: [
        {
          question: "Which fruits do you like?",
          header: "Fruits",
          options: [{ label: "Apple" }, { label: "Banana" }, { label: "Cherry" }],
          multiSelect: true,
          allowOther: true,
        },
      ],
    });

    if (!questions) throw new Error("questions did not parse");
    expect(buildQuestionFormAnswers(questions, { 0: new Set([0, 2]) }, { 0: " durian " })).toEqual({
      Fruits: "Apple, Cherry, durian",
    });
    expect(buildQuestionFormAnswers(questions, { 0: new Set([0, 2]) }, {})).toEqual({
      Fruits: "Apple, Cherry",
    });
    expect(buildQuestionFormAnswers(questions, { 0: new Set() }, { 0: "durian" })).toEqual({
      Fruits: "durian",
    });
    expect(buildQuestionFormAnswers(questions, {}, { 0: "durian" })).toEqual({ Fruits: "durian" });
  });

  test("replaces the selected option with the other answer for single-select", () => {
    const questions = parseQuestionFormQuestions({
      questions: [
        {
          question: "Which provider?",
          header: "Provider",
          options: [{ label: "Claude Code" }, { label: "Codex" }],
          multiSelect: false,
          allowOther: true,
        },
      ],
    });

    if (!questions) throw new Error("questions did not parse");
    expect(buildQuestionFormAnswers(questions, { 0: new Set([1]) }, { 0: "OpenCode" })).toEqual({
      Provider: "OpenCode",
    });
    expect(buildQuestionFormAnswers(questions, { 0: new Set([1]) }, {})).toEqual({
      Provider: "Codex",
    });
    expect(buildQuestionFormNotes(questions, { 0: new Set([1]) }, { 0: "OpenCode" })).toBeNull();
    const [question] = questions;
    if (!question) throw new Error("question missing");
    expect(questionPickReplacesText(question)).toBe(true);
    expect(questionPickAdvances(question, new Set([1]))).toBe(true);
  });

  test("shows text input for explicit other questions", () => {
    const questions = parseQuestionFormQuestions({
      questions: [
        {
          question: "Pick or type",
          header: "Response",
          options: [{ label: "A" }],
          isOther: true,
          multiSelect: false,
        },
      ],
    });

    if (!questions) throw new Error("questions did not parse");
    const [question] = questions;
    if (!question) throw new Error("question missing");
    expect(questionShowsTextInput(question)).toBe(true);
    expect(areQuestionsAnswered(questions, {}, { 0: "custom" })).toBe(true);
    expect(buildQuestionFormAnswers(questions, {}, { 0: "custom" })).toEqual({
      Response: "custom",
    });
  });

  test("shows text input for questions that allow other answers", () => {
    const questions = parseQuestionFormQuestions({
      questions: [
        {
          question: "Pick or type",
          header: "Response",
          options: [{ label: "A" }],
          allowOther: true,
          multiSelect: false,
        },
      ],
    });

    if (!questions) throw new Error("questions did not parse");
    const [question] = questions;
    if (!question) throw new Error("question missing");
    expect(questionShowsTextInput(question)).toBe(true);
    expect(areQuestionsAnswered(questions, {}, { 0: "custom" })).toBe(true);
    expect(buildQuestionFormAnswers(questions, {}, { 0: "custom" })).toEqual({
      Response: "custom",
    });
  });

  describe("questions that allow notes", () => {
    const singleSelect = {
      question: "Which deadline?",
      header: "Deadline",
      options: [{ label: "3-month" }, { label: "6-month" }],
      multiSelect: false,
      allowOther: true,
      allowNotes: true,
    };

    test("carries a note on the selected option instead of replacing it", () => {
      const questions = parseQuestions(singleSelect);
      const selections = { 0: new Set([1]) };
      const otherTexts = { 0: " but make the refund window 30 days " };

      expect(resolveQuestionTextRole(questions[0], selections[0])).toBe("note");
      expect(buildQuestionFormAnswers(questions, selections, otherTexts)).toEqual({
        Deadline: "6-month",
      });
      expect(buildQuestionFormNotes(questions, selections, otherTexts)).toEqual({
        Deadline: "but make the refund window 30 days",
      });
    });

    test("treats the text as the Other answer once nothing is selected", () => {
      const questions = parseQuestions(singleSelect);
      const otherTexts = { 0: "9-month" };

      const cases: QuestionSelections[] = [{}, { 0: new Set<number>() }];
      for (const selections of cases) {
        expect(resolveQuestionTextRole(questions[0], selections[0])).toBe("answer");
        expect(areQuestionsAnswered(questions, selections, otherTexts)).toBe(true);
        expect(buildQuestionFormAnswers(questions, selections, otherTexts)).toEqual({
          Deadline: "9-month",
        });
        expect(buildQuestionFormNotes(questions, selections, otherTexts)).toBeNull();
      }
    });

    test("omits blank notes", () => {
      const questions = parseQuestions(singleSelect);
      expect(buildQuestionFormNotes(questions, { 0: new Set([0]) }, { 0: "   " })).toBeNull();
      expect(buildQuestionFormNotes(questions, { 0: new Set([0]) }, {})).toBeNull();
    });

    test("keeps the text and stays on the question when an option is picked", () => {
      const [question] = parseQuestions(singleSelect);
      expect(questionPickReplacesText(question)).toBe(false);
      expect(questionPickAdvances(question, new Set([0]))).toBe(false);
    });

    test("keeps the note out of multi-select answers while options are checked", () => {
      const questions = parseQuestions({ ...singleSelect, multiSelect: true });
      const otherTexts = { 0: "staggered" };

      expect(buildQuestionFormAnswers(questions, { 0: new Set([0, 1]) }, otherTexts)).toEqual({
        Deadline: "3-month, 6-month",
      });
      expect(buildQuestionFormNotes(questions, { 0: new Set([0, 1]) }, otherTexts)).toEqual({
        Deadline: "staggered",
      });
      expect(buildQuestionFormAnswers(questions, { 0: new Set() }, otherTexts)).toEqual({
        Deadline: "staggered",
      });
      expect(buildQuestionFormNotes(questions, { 0: new Set() }, otherTexts)).toBeNull();
    });

    test("offers the box only as a note when Other answers are not allowed", () => {
      const questions = parseQuestions({ ...singleSelect, allowOther: false });
      const otherTexts = { 0: "orphaned note" };

      expect(resolveQuestionTextRole(questions[0], new Set())).toBeNull();
      expect(resolveQuestionTextRole(questions[0], new Set([0]))).toBe("note");
      expect(areQuestionsAnswered(questions, {}, otherTexts)).toBe(false);
      expect(buildQuestionFormAnswers(questions, { 0: new Set() }, otherTexts)).toEqual({});
      expect(buildQuestionFormNotes(questions, { 0: new Set() }, otherTexts)).toBeNull();
      expect(buildQuestionFormNotes(questions, { 0: new Set([0]) }, otherTexts)).toEqual({
        Deadline: "orphaned note",
      });
    });
  });
});
