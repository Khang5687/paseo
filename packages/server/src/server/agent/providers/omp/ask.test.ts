import { describe, expect, test } from "vitest";

import { OmpHarness } from "./test-utils/omp-harness.js";

function startAsk(omp: OmpHarness, multi: boolean): void {
  omp.emit({
    type: "tool_execution_start",
    toolCallId: "ask-1",
    toolName: "ask",
    args: {
      questions: [
        {
          id: "colors",
          question: "Which colors?",
          multi,
          options: [
            { label: "Red", description: "Warm" },
            { label: "Blue", description: "Cool" },
          ],
        },
      ],
    },
  });
}

function select(omp: OmpHarness, id: string, title: string, options: string[]): void {
  omp.emit({ type: "extension_ui_request", id, method: "select", title, options });
}

// COMPAT(ompAskDialog): OMP before 18.4.10 rejects set_ask_dialog; delete this suite with the replay.
async function startOmpWithoutAskDialog(): Promise<OmpHarness> {
  const omp = new OmpHarness();
  omp.setAskDialogSupport(new Error("Unknown command: set_ask_dialog"));
  await omp.start();
  return omp;
}

describe("OMP ask replay through select prompts", () => {
  test("recognizes ask arguments from the assistant message before the UI request", async () => {
    const omp = await startOmpWithoutAskDialog();
    omp.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "ask-1",
            name: "ask",
            arguments: {
              questions: [
                {
                  id: "colors",
                  question: "Which colors?",
                  multi: true,
                  options: [
                    { label: "Red", description: "Warm" },
                    { label: "Blue", description: "Cool" },
                  ],
                },
              ],
            },
          },
        ],
      },
    });
    select(omp, "select-1", "Which colors?", ["Red", "Blue", "Other (type your own)"]);
    expect(omp.pendingPermissions()[0]?.input?.questions?.[0]).toMatchObject({
      multiSelect: true,
      allowOther: true,
    });
    startAsk(omp, true);
  });
  test("answers the multi-select loop from one Paseo question", async () => {
    const omp = await startOmpWithoutAskDialog();
    startAsk(omp, true);
    select(omp, "select-1", "Which colors?", ["Red", "Blue", "Other (type your own)"]);

    expect(omp.pendingPermissions()).toHaveLength(1);
    expect(omp.pendingPermissions()[0]).toMatchObject({
      kind: "question",
      input: {
        questions: [
          {
            question: "Which colors?",
            multiSelect: true,
            allowOther: true,
            options: [{ label: "Red" }, { label: "Blue" }],
          },
        ],
      },
    });
    await omp.respondToPermission("select-1", {
      behavior: "allow",
      updatedInput: { answers: { Response: "Blue, Red" } },
    });
    select(omp, "select-2", "(1 selected) Which colors?", [
      "Red",
      "Blue",
      "✓ Done selecting",
      "Other (type your own)",
    ]);
    select(omp, "select-3", "(2 selected) Which colors?", [
      "Red",
      "Blue",
      "✔ Done selecting",
      "Other (type your own)",
    ]);

    expect(omp.pendingPermissions()).toHaveLength(0);
    expect(omp.extensionUiResponses()).toEqual([
      { id: "select-1", response: { value: "Blue" } },
      { id: "select-2", response: { value: "Red" } },
      { id: "select-3", response: { value: "✔ Done selecting" } },
    ]);
  });

  test("passes a single-select Other answer through OMP's editor", async () => {
    const omp = await startOmpWithoutAskDialog();
    startAsk(omp, false);
    select(omp, "select-1", "Which colors?", ["Red", "Blue", "Other (type your own)"]);
    expect(omp.pendingPermissions()[0]?.input?.questions?.[0]).toMatchObject({ allowOther: true });
    await omp.respondToPermission("select-1", {
      behavior: "allow",
      updatedInput: { answers: { Response: "Violet" } },
    });
    omp.emit({
      type: "extension_ui_request",
      id: "editor-1",
      method: "editor",
      title: "Which colors? ○ Red ○ Blue ◉ Other (type your own) Enter your response:",
    });

    expect(omp.pendingPermissions()).toHaveLength(0);
    expect(omp.extensionUiResponses()).toEqual([
      { id: "select-1", response: { value: "Other (type your own)" } },
      { id: "editor-1", response: { value: "Violet" } },
    ]);
  });

  test("passes multi-select choices and Other through the same editor flow", async () => {
    const omp = await startOmpWithoutAskDialog();
    startAsk(omp, true);
    select(omp, "select-1", "Which colors?", ["Red", "Blue", "Other (type your own)"]);
    await omp.respondToPermission("select-1", {
      behavior: "allow",
      updatedInput: { answers: { Response: "Red, Violet" } },
    });
    select(omp, "select-2", "(1 selected) Which colors?", [
      "Red",
      "Blue",
      "✓ Done selecting",
      "Other (type your own)",
    ]);
    omp.emit({
      type: "extension_ui_request",
      id: "editor-1",
      method: "editor",
      title: "(1 selected) Which colors?",
    });

    expect(omp.pendingPermissions()).toHaveLength(0);
    expect(omp.extensionUiResponses()).toEqual([
      { id: "select-1", response: { value: "Red" } },
      { id: "select-2", response: { value: "Other (type your own)" } },
      { id: "editor-1", response: { value: "Violet" } },
    ]);
  });

  test("cancels an ask without leaving replay state behind", async () => {
    const omp = await startOmpWithoutAskDialog();
    startAsk(omp, true);
    select(omp, "select-1", "Which colors?", ["Red", "Blue", "Other (type your own)"]);
    await omp.respondToPermission("select-1", { behavior: "deny" });
    select(omp, "select-after-cancel", "Another question", ["One", "Two"]);

    expect(omp.extensionUiResponses()).toEqual([{ id: "select-1", response: { cancelled: true } }]);
    expect(omp.pendingPermissions()).toHaveLength(1);
    expect(omp.pendingPermissions()[0]?.id).toBe("select-after-cancel");
  });

  test("keeps single choices, tool approvals, and free-form input independent", async () => {
    const omp = await startOmpWithoutAskDialog();
    startAsk(omp, false);
    select(omp, "select-1", "Which colors?", ["Red", "Blue", "Other (type your own)"]);
    await omp.respondToPermission("select-1", {
      behavior: "allow",
      updatedInput: { answers: { Response: "Blue" } },
    });
    expect(omp.extensionUiResponses()).toContainEqual({
      id: "select-1",
      response: { value: "Blue" },
    });

    omp.emit({
      type: "tool_execution_end",
      toolCallId: "ask-1",
      toolName: "ask",
      result: "Blue",
      isError: false,
    });
    omp.requestToolApproval({ id: "approval", tool: "bash", detail: "echo hi" });
    expect(omp.pendingPermissions()[0]).toMatchObject({ id: "approval", kind: "tool" });
    await omp.respondToPermission("approval", { behavior: "allow" });
    expect(omp.extensionUiResponses()).toContainEqual({
      id: "approval",
      response: { value: "Approve" },
    });

    omp.emit({ type: "extension_ui_request", id: "input", method: "input", title: "Type a value" });
    expect(omp.pendingPermissions()[0]).toMatchObject({ id: "input", kind: "question" });
    await omp.respondToPermission("input", {
      behavior: "allow",
      updatedInput: { answers: { Response: "typed value" } },
    });
    expect(omp.extensionUiResponses()).toContainEqual({
      id: "input",
      response: { value: "typed value" },
    });
  });

  test("recognizes OMP's numbered question title", async () => {
    const omp = await startOmpWithoutAskDialog();
    startAsk(omp, true);
    select(omp, "select-1", "Which colors? (1/2)", ["Red", "Blue", "Other (type your own)"]);
    expect(omp.pendingPermissions()[0]?.input?.questions?.[0]).toMatchObject({ multiSelect: true });
  });

  test("keeps descriptions with their labels when a select event reorders rows", async () => {
    const omp = await startOmpWithoutAskDialog();
    startAsk(omp, true);
    select(omp, "select-1", "Which colors?", ["Blue", "Red", "Other (type your own)"]);

    expect(omp.pendingPermissions()[0]?.input?.questions?.[0]?.options).toEqual([
      { label: "Blue", description: "Cool" },
      { label: "Red", description: "Warm" },
    ]);
  });

  test("keeps a recommended option's description with its display label", async () => {
    const omp = await startOmpWithoutAskDialog();
    startAsk(omp, false);
    select(omp, "select-1", "Which colors?", [
      "Red (Recommended)",
      "Blue",
      "Other (type your own)",
    ]);
    expect(omp.pendingPermissions()[0]?.input?.questions?.[0]?.options).toEqual([
      { label: "Red (Recommended)", description: "Warm" },
      { label: "Blue", description: "Cool" },
    ]);
  });

  test("cancels cleanly when OMP omits Done selecting in a multi-question ask", async () => {
    const omp = await startOmpWithoutAskDialog();
    omp.emit({
      type: "tool_execution_start",
      toolCallId: "ask-1",
      toolName: "ask",
      args: {
        questions: [
          {
            id: "colors",
            question: "Which colors?",
            multi: true,
            options: [{ label: "Red" }, { label: "Blue" }],
          },
          {
            id: "shape",
            question: "Which shape?",
            options: [{ label: "Round" }, { label: "Square" }],
          },
        ],
      },
    });
    select(omp, "select-1", "Which colors? (1/2)", ["Red", "Blue", "Other (type your own)"]);
    await omp.respondToPermission("select-1", {
      behavior: "allow",
      updatedInput: { answers: { Response: "Red" } },
    });
    // OMP's RPC select omits the right-arrow navigation callback and, with
    // allowForward true, also omits its Done row on every follow-up request.
    select(omp, "select-2", "(1 selected) Which colors? (1/2)", [
      "Red",
      "Blue",
      "Other (type your own)",
    ]);

    expect(omp.extensionUiResponses()).toEqual([
      { id: "select-1", response: { value: "Red" } },
      { id: "select-2", response: { cancelled: true } },
    ]);
    expect(omp.pendingPermissions()).toHaveLength(0);
    omp.emit({
      type: "tool_execution_end",
      toolCallId: "ask-1",
      toolName: "ask",
      result: "Ask tool was cancelled by the user",
      isError: true,
    });
    expect(omp.timeline()).toContainEqual(
      expect.objectContaining({
        type: "tool_call",
        name: "ask",
        status: "failed",
      }),
    );
  });
});

const DIALOG_QUESTIONS = [
  {
    id: "db",
    header: "Database",
    question: "Which database?",
    options: [{ label: "Postgres", description: "Server" }, { label: "SQLite" }],
    recommended: 1,
  },
  {
    id: "features",
    question: "Which features?",
    options: [{ label: "Auth" }, { label: "Billing" }, { label: "Search" }],
    multi: true,
  },
];

function askDialog(omp: OmpHarness, questions: unknown[] = DIALOG_QUESTIONS): void {
  omp.emit({ type: "extension_ui_request", id: "ask-ui", method: "ask", questions });
}

describe("OMP ask dialog", () => {
  test("shows every question in one card and returns selections, Other text, and notes", async () => {
    const omp = new OmpHarness();
    await omp.start();
    askDialog(omp);

    expect(omp.pendingPermissions()).toEqual([
      expect.objectContaining({
        id: "ask-ui",
        kind: "question",
        input: {
          questions: [
            {
              question: "Which database?",
              header: "Database",
              options: [
                { label: "Postgres", description: "Server" },
                { label: "SQLite (Recommended)" },
              ],
              multiSelect: false,
              allowOther: true,
              allowNotes: true,
            },
            {
              question: "Which features?",
              header: "features",
              options: [{ label: "Auth" }, { label: "Billing" }, { label: "Search" }],
              multiSelect: true,
              allowOther: true,
              allowNotes: true,
            },
          ],
        },
      }),
    ]);

    await omp.respondToPermission("ask-ui", {
      behavior: "allow",
      updatedInput: {
        answers: { Database: "SQLite (Recommended)", features: "Auth, Search, Export" },
        answerLists: {
          Database: ["SQLite (Recommended)"],
          features: ["Auth", "Search", "Export"],
        },
        notes: { Database: "  Keep it local  ", features: "   " },
      },
    });

    expect(omp.pendingPermissions()).toEqual([]);
    expect(omp.extensionUiResponses()).toEqual([
      {
        id: "ask-ui",
        response: {
          answers: [
            { id: "db", selectedOptions: ["SQLite"], note: "Keep it local" },
            { id: "features", selectedOptions: ["Auth", "Search"], customInput: "Export" },
          ],
        },
      },
    ]);
  });

  test("splits an older app's comma-joined answers on exact option labels", async () => {
    const omp = new OmpHarness();
    await omp.start();
    askDialog(omp);

    await omp.respondToPermission("ask-ui", {
      behavior: "allow",
      updatedInput: { answers: { Database: "DuckDB", features: "Search, Auth, Export, CSV" } },
    });

    expect(omp.extensionUiResponses()[0]?.response).toEqual({
      answers: [
        { id: "db", selectedOptions: [], customInput: "DuckDB" },
        { id: "features", selectedOptions: ["Search", "Auth"], customInput: "Export, CSV" },
      ],
    });
  });

  test("keeps notes off when OMP does not read them", async () => {
    const omp = new OmpHarness();
    omp.setAskDialogSupport({ enabled: true, notes: false });
    await omp.start();
    askDialog(omp, [DIALOG_QUESTIONS[0]]);

    expect(omp.pendingPermissions()[0]?.input?.questions?.[0]).not.toHaveProperty("allowNotes");
    await omp.respondToPermission("ask-ui", {
      behavior: "allow",
      updatedInput: {
        answers: { Database: "Postgres" },
        answerLists: { Database: ["Postgres"] },
        notes: { Database: "Lost on this OMP" },
      },
    });
    expect(omp.extensionUiResponses()[0]?.response).toEqual({
      answers: [{ id: "db", selectedOptions: ["Postgres"] }],
    });
  });

  test("keys answers by question id when OMP headers repeat", async () => {
    const omp = new OmpHarness();
    await omp.start();
    askDialog(omp, [
      { id: "first", header: "Pick", question: "First?", options: [{ label: "A" }] },
      { id: "second", header: "Pick", question: "Second?", options: [{ label: "B" }] },
    ]);

    const questions = omp.pendingPermissions()[0]?.input?.questions as Array<{ header: string }>;
    expect(questions.map((question) => question.header)).toEqual(["first", "second"]);
    await omp.respondToPermission("ask-ui", {
      behavior: "allow",
      updatedInput: { answers: { first: "A", second: "B" } },
    });
    expect(omp.extensionUiResponses()[0]?.response).toEqual({
      answers: [
        { id: "first", selectedOptions: ["A"] },
        { id: "second", selectedOptions: ["B"] },
      ],
    });
  });

  test("cancels the ask when the user dismisses the card", async () => {
    const omp = new OmpHarness();
    await omp.start();
    askDialog(omp);

    await omp.respondToPermission("ask-ui", { behavior: "deny" });

    expect(omp.extensionUiResponses()).toEqual([{ id: "ask-ui", response: { cancelled: true } }]);
  });

  test("cancels a dialog it cannot read instead of leaving OMP waiting", async () => {
    const omp = new OmpHarness();
    await omp.start();
    askDialog(omp, [{ id: "db", question: "Which database?" }]);

    expect(omp.pendingPermissions()).toEqual([]);
    expect(omp.extensionUiResponses()).toEqual([{ id: "ask-ui", response: { cancelled: true } }]);
  });

  test("removes the card when OMP closes the dialog after a timeout or abort", async () => {
    const omp = new OmpHarness();
    await omp.start();
    askDialog(omp);

    omp.emit({ type: "extension_ui_request", id: "close-1", method: "cancel", targetId: "ask-ui" });

    expect(omp.pendingPermissions()).toEqual([]);
    expect(omp.eventTypes()).toContain("permission_resolved");
    expect(omp.extensionUiResponses()).toEqual([]);
  });
});
