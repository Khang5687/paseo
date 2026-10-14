import { describe, expect, test } from "vitest";
import {
  areQuestionsAnswered,
  buildQuestionFormAnswers,
  isOneTapQuestion,
  parseQuestionFormQuestions,
  questionShowsTextInput,
  resolveDismissLabel,
  shouldSubmitEmptyOnDismiss,
} from "./question-form-card-core";

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

  test("answers with one tap only a lone single-choice question with bare options", () => {
    const base = {
      question: "Dangerous command",
      header: "Answer",
      options: [{ label: "Allow once" }, { label: "Deny" }],
      multiSelect: false,
    };
    const oneTap = (questions: Record<string, unknown>[]) => {
      const parsed = parseQuestionFormQuestions({ questions });
      if (!parsed) throw new Error("questions did not parse");
      return isOneTapQuestion(parsed);
    };

    expect(oneTap([base])).toBe(true);
    expect(oneTap([{ ...base, multiSelect: true }])).toBe(false);
    expect(oneTap([{ ...base, allowOther: true }])).toBe(false);
    expect(oneTap([{ ...base, options: [] }])).toBe(false);
    expect(oneTap([{ ...base, options: [{ label: "A", description: "detail" }] }])).toBe(false);
    expect(oneTap([{ ...base, options: [{ label: "A", description: " \n" }] }])).toBe(true);
    expect(oneTap([base, { ...base, header: "Second" }])).toBe(false);
  });
});
