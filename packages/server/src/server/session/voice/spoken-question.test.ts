import { describe, expect, test } from "vitest";

import type { AgentPermissionRequest } from "../../agent/agent-sdk-types.js";
import {
  buildPermissionSpeech,
  buildQuestionSpeech,
  interpretSpokenAnswer,
  parseSpokenQuestions,
  type SpokenQuestion,
} from "./spoken-question.js";

function question(overrides: Partial<SpokenQuestion> = {}): SpokenQuestion {
  return {
    question: "Which cache should I use?",
    header: "Cache",
    options: ["Redis", "Memcached", "In-memory map"],
    multiSelect: false,
    allowOther: false,
    ...overrides,
  };
}

describe("parseSpokenQuestions", () => {
  test("reads the card shape the app renders", () => {
    const parsed = parseSpokenQuestions({
      questions: [
        {
          question: "Ship it?",
          header: "Ship",
          options: [{ label: "Yes", description: "now" }, { label: "No" }],
          multiSelect: true,
          isOther: true,
        },
      ],
    });
    expect(parsed).toEqual([
      {
        question: "Ship it?",
        header: "Ship",
        options: ["Yes", "No"],
        multiSelect: true,
        allowOther: true,
      },
    ]);
  });

  test("rejects input that is not a question card", () => {
    expect(parseSpokenQuestions(undefined)).toBeNull();
    expect(parseSpokenQuestions({ questions: [] })).toBeNull();
    expect(parseSpokenQuestions({ questions: [{ question: "x" }] })).toBeNull();
  });
});

describe("buildQuestionSpeech", () => {
  test("reads the question word for word, then the option labels", () => {
    expect(buildQuestionSpeech(question(), { index: 0, total: 1 })).toBe(
      "Which cache should I use? Options: Redis. Memcached. In-memory map.",
    );
  });

  test("numbers the questions of a multi-question card and flags multi-select", () => {
    expect(buildQuestionSpeech(question({ multiSelect: true }), { index: 1, total: 3 })).toBe(
      "Question 2 of 3. Which cache should I use? Options: Redis. Memcached. In-memory map. You can pick more than one.",
    );
  });

  test("reads a free-text question with no options", () => {
    expect(buildQuestionSpeech(question({ options: [] }), { index: 0, total: 1 })).toBe(
      "Which cache should I use?",
    );
  });
});

describe("buildPermissionSpeech", () => {
  test("reads the provider's title and description, then points at the screen", () => {
    const request: AgentPermissionRequest = {
      id: "p1",
      provider: "claude",
      name: "Bash",
      kind: "tool",
      title: "Run command",
      description: "Needs network access",
    };
    expect(buildPermissionSpeech(request)).toBe(
      "Permission needed. Run command Needs network access Answer it on screen.",
    );
  });

  test("falls back to the tool name when the provider sent no title", () => {
    const request: AgentPermissionRequest = {
      id: "p2",
      provider: "omp",
      name: "write",
      kind: "tool",
    };
    expect(buildPermissionSpeech(request)).toBe(
      "Permission needed. Allow tool: write Answer it on screen.",
    );
  });
});

describe("interpretSpokenAnswer", () => {
  test("picks the option named in the reply", () => {
    expect(interpretSpokenAnswer(question(), "Let's go with Redis.")).toEqual({
      kind: "answer",
      answer: "Redis",
    });
  });

  test("picks an option by position", () => {
    expect(interpretSpokenAnswer(question(), "the second one")).toEqual({
      kind: "answer",
      answer: "Memcached",
    });
    expect(interpretSpokenAnswer(question(), "Option 3")).toEqual({
      kind: "answer",
      answer: "In-memory map",
    });
  });

  test("picks an option from part of its label", () => {
    const q = question({ options: ["Use Redis for caching", "Skip caching entirely"] });
    expect(interpretSpokenAnswer(q, "I'd go with redis please")).toEqual({
      kind: "answer",
      answer: "Use Redis for caching",
    });
  });

  test("prefers the longer label when a short label sits inside it", () => {
    const q = question({ options: ["Yes", "Yes, and add tests", "No"] });
    expect(interpretSpokenAnswer(q, "yes and add tests")).toEqual({
      kind: "answer",
      answer: "Yes, and add tests",
    });
  });

  test("a one-letter label only matches a reply that is exactly that letter", () => {
    const q = question({ options: ["A", "B"] });
    expect(interpretSpokenAnswer(q, "B")).toEqual({ kind: "answer", answer: "B" });
    expect(interpretSpokenAnswer(q, "that is a lot to take in")).toEqual({ kind: "unclear" });
  });

  test("joins several options for a multi-select question", () => {
    const q = question({ multiSelect: true });
    expect(interpretSpokenAnswer(q, "Redis and memcached")).toEqual({
      kind: "answer",
      answer: "Redis, Memcached",
    });
  });

  test("two options in a single-select reply are unclear, not a guess", () => {
    expect(interpretSpokenAnswer(question(), "Redis or memcached")).toEqual({ kind: "unclear" });
  });

  test("uses the reply as typed text when the card takes free text", () => {
    expect(
      interpretSpokenAnswer(question({ allowOther: true }), "Valkey, it is a drop-in."),
    ).toEqual({
      kind: "answer",
      answer: "Valkey, it is a drop-in.",
    });
    expect(interpretSpokenAnswer(question({ options: [] }), "call it fast cache")).toEqual({
      kind: "answer",
      answer: "call it fast cache",
    });
  });

  test("a reply that names no option on an options-only card is unclear", () => {
    expect(interpretSpokenAnswer(question(), "hmm, not sure")).toEqual({ kind: "unclear" });
    expect(interpretSpokenAnswer(question(), "")).toEqual({ kind: "unclear" });
  });

  test("repeat and dismiss are commands, unless they are an option", () => {
    expect(interpretSpokenAnswer(question(), "say that again")).toEqual({ kind: "repeat" });
    expect(interpretSpokenAnswer(question(), "What's the question?")).toEqual({ kind: "repeat" });
    expect(interpretSpokenAnswer(question(), "dismiss")).toEqual({ kind: "dismiss" });
    expect(interpretSpokenAnswer(question(), "Never mind.")).toEqual({ kind: "dismiss" });
    expect(interpretSpokenAnswer(question({ options: ["Ship", "Skip"] }), "skip")).toEqual({
      kind: "answer",
      answer: "Skip",
    });
  });
});
