import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { within } from "@testing-library/dom";
import type { AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n as testI18n } from "@/i18n/i18next";
import type { PendingPermission } from "@/types/shared";
import { QuestionFormCard } from "./question-form-card";

// Load translations so controls expose their real accessible names.
void testI18n;

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));

/**
 * A real browser with the real web `EditingTextInput`, because the bug under test lives in the
 * gap between that input and React state: the input owns its text and never replays state, so a
 * card that drops the Other text from state alone keeps showing it while submit ignores it.
 */

interface Mounted {
  root: Root;
  container: HTMLDivElement;
}

const mounted: Mounted[] = [];

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

function buildPermission(question: Record<string, unknown>): PendingPermission {
  return {
    key: "perm-1",
    agentId: "agent-1",
    request: {
      id: "perm-1",
      provider: "claude",
      name: "AskUserQuestion",
      kind: "question",
      input: { questions: [question] },
    },
  };
}

function mountCard(question: Record<string, unknown>) {
  const onRespond = vi.fn<(response: AgentPermissionResponse) => void>();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <QuestionFormCard
        permission={buildPermission(question)}
        onRespond={onRespond}
        isResponding={false}
      />,
    ),
  );
  mounted.push({ root, container });

  const view = within(container);
  const optionRole = question.multiSelect ? "checkbox" : "radio";
  const otherInput = () =>
    view.getByRole<HTMLInputElement>("textbox", { name: String(question.question) });
  const check = (label: string) => act(() => view.getByRole(optionRole, { name: label }).click());
  const type = (text: string) => {
    const input = otherInput();
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!valueSetter) throw new Error("HTML input value setter is unavailable");
    act(() => {
      valueSetter.call(input, text);
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
    });
  };
  const submit = () => act(() => view.getByRole("button", { name: "Submit" }).click());
  const submittedInput = (): Record<string, unknown> => {
    const response = onRespond.mock.calls[0]?.[0];
    if (!response || response.behavior !== "allow") throw new Error("card did not submit");
    return response.updatedInput ?? {};
  };
  const submittedAnswers = () => submittedInput().answers as Record<string, string>;
  const queryOtherInput = () =>
    view.queryByRole<HTMLInputElement>("textbox", { name: String(question.question) });
  return { check, type, otherInput, queryOtherInput, submit, submittedAnswers, submittedInput };
}

const multiSelectQuestion = {
  question: "Which fruits do you like?",
  header: "Fruits",
  options: [{ label: "Apple" }, { label: "Banana" }, { label: "Cherry" }],
  multiSelect: true,
  allowOther: true,
};

const singleSelectQuestion = {
  question: "Which provider?",
  header: "Provider",
  options: [{ label: "Claude Code" }, { label: "Codex" }],
  multiSelect: false,
  allowOther: true,
};

describe("QuestionFormCard other answers", () => {
  it("keeps checked options when the other answer is typed afterwards (multi-select)", () => {
    const card = mountCard(multiSelectQuestion);

    card.check("Apple");
    card.check("Cherry");
    card.type("durian");
    card.submit();

    expect(card.submittedAnswers()).toEqual({ Fruits: "Apple, Cherry, durian" });
  });

  it("keeps the typed other answer when options are checked afterwards (multi-select)", () => {
    const card = mountCard(multiSelectQuestion);

    card.type("durian");
    card.check("Apple");
    card.check("Banana");

    expect(card.otherInput().value).toBe("durian");
    card.submit();
    expect(card.submittedAnswers()).toEqual({ Fruits: "Apple, Banana, durian" });
  });

  it("replaces the selected option with the typed other answer (single-select)", () => {
    const card = mountCard(singleSelectQuestion);

    card.check("Codex");
    card.type("OpenCode");
    card.submit();

    expect(card.submittedAnswers()).toEqual({ Provider: "OpenCode" });
  });

  it("clears the typed other answer on screen when an option is picked afterwards (single-select)", () => {
    const card = mountCard(singleSelectQuestion);

    card.type("OpenCode");
    card.check("Codex");

    expect(card.otherInput().value).toBe("");
    card.submit();
    expect(card.submittedAnswers()).toEqual({ Provider: "Codex" });
  });
});

describe("QuestionFormCard notes", () => {
  const deadlineQuestion = {
    question: "Which deadline?",
    header: "Deadline",
    options: [{ label: "3-month" }, { label: "6-month" }],
    multiSelect: false,
    allowOther: true,
    allowNotes: true,
  };

  it("submits the typed text as a note on the selected option", () => {
    const card = mountCard(deadlineQuestion);

    expect(card.otherInput().placeholder).toBe("Other...");
    card.check("6-month");
    expect(card.otherInput().placeholder).toBe("Add a note...");
    card.type("but make the refund window 30 days");
    card.check("3-month");

    expect(card.otherInput().value).toBe("but make the refund window 30 days");
    card.submit();
    expect(card.submittedInput()).toMatchObject({
      answers: { Deadline: "3-month" },
      notes: { Deadline: "but make the refund window 30 days" },
    });
  });

  it("turns the note back into the Other answer when the option is deselected", () => {
    const card = mountCard(deadlineQuestion);

    card.check("6-month");
    card.type("9-month");
    card.check("6-month");

    expect(card.otherInput().placeholder).toBe("Other...");
    card.submit();
    expect(card.submittedAnswers()).toEqual({ Deadline: "9-month" });
    expect(card.submittedInput()).not.toHaveProperty("notes");
  });

  it("shows the box only once an option is selected when Other answers are not allowed", () => {
    const card = mountCard({ ...deadlineQuestion, allowOther: false });

    expect(card.queryOtherInput()).toBeNull();
    card.check("3-month");
    expect(card.otherInput().placeholder).toBe("Add a note...");
  });
});
