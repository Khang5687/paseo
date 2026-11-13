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

describe("OMP ask RPC UI", () => {
  test("recognizes ask arguments from the assistant message before the UI request", async () => {
    const omp = new OmpHarness();
    await omp.start();
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
    const omp = new OmpHarness();
    await omp.start();
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
    const omp = new OmpHarness();
    await omp.start();
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
    const omp = new OmpHarness();
    await omp.start();
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

  test("keeps an Other answer that starts with an option label apart from the choices", async () => {
    const omp = new OmpHarness();
    await omp.start();
    startAsk(omp, true);
    select(omp, "select-1", "Which colors?", ["Red", "Blue", "Other (type your own)"]);
    await omp.respondToPermission("select-1", {
      behavior: "allow",
      updatedInput: {
        answers: { Response: "Red, Blue, but darker" },
        answerLists: { Response: ["Red", "Blue, but darker"] },
      },
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
      { id: "editor-1", response: { value: "Blue, but darker" } },
    ]);
  });

  test("cancels an ask without leaving replay state behind", async () => {
    const omp = new OmpHarness();
    await omp.start();
    startAsk(omp, true);
    select(omp, "select-1", "Which colors?", ["Red", "Blue", "Other (type your own)"]);
    await omp.respondToPermission("select-1", { behavior: "deny" });
    select(omp, "select-after-cancel", "Another question", ["One", "Two"]);

    expect(omp.extensionUiResponses()).toEqual([{ id: "select-1", response: { cancelled: true } }]);
    expect(omp.pendingPermissions()).toHaveLength(1);
    expect(omp.pendingPermissions()[0]?.id).toBe("select-after-cancel");
  });

  test("keeps single choices, tool approvals, and free-form input independent", async () => {
    const omp = new OmpHarness();
    await omp.start();
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
    const omp = new OmpHarness();
    await omp.start();
    startAsk(omp, true);
    select(omp, "select-1", "Which colors? (1/2)", ["Red", "Blue", "Other (type your own)"]);
    expect(omp.pendingPermissions()[0]?.input?.questions?.[0]).toMatchObject({ multiSelect: true });
  });

  test("keeps descriptions with their labels when a select event reorders rows", async () => {
    const omp = new OmpHarness();
    await omp.start();
    startAsk(omp, true);
    select(omp, "select-1", "Which colors?", ["Blue", "Red", "Other (type your own)"]);

    expect(omp.pendingPermissions()[0]?.input?.questions?.[0]?.options).toEqual([
      { label: "Blue", description: "Cool" },
      { label: "Red", description: "Warm" },
    ]);
  });

  test("keeps a recommended option's description with its display label", async () => {
    const omp = new OmpHarness();
    await omp.start();
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
    const omp = new OmpHarness();
    await omp.start();
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

// Recorded from OMP 18.18.6 `--mode rpc-ui`: the assistant message, then the
// first prompt, then tool_execution_start; one prompt per field after that.
const FORM = `<form>
  <p>Sessions live in memory &amp; are lost on restart.</p>
  <fieldset>
    <legend>Session store</legend>
    <label><input type="radio" name="store" value="sqlite" checked> SQLite: one file</label>
    <label><input type="radio" name="store" value="redis"> Redis: shared</label>
  </fieldset>
  <fieldset>
    <legend>Extras</legend>
    <label><input type="checkbox" name="extras" value="a" checked> Alpha</label>
    <label><input type="checkbox" name="extras" value="b"> Beta</label>
  </fieldset>
  <label>Region <select name="region"><option value="us">US</option><option value="eu" selected>EU</option></select></label>
  <label>Lifetime (days) <input type="number" name="ttl" value="30" min="1"></label>
</form>`;
const STORE_ROWS = ["SQLite: one file", "Redis: shared", "Other (type your own)"];
const EXTRAS_ROWS = ["Alpha", "Beta", "Other (type your own)", "✔ Done selecting"];

function startFormAsk(omp: OmpHarness): void {
  const args = { html: FORM };
  omp.emit({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "ask-html", name: "ask", arguments: args }],
    },
  });
  select(omp, "store", "Session store", STORE_ROWS);
  omp.emit({ type: "tool_execution_start", toolCallId: "ask-html", toolName: "ask", args });
}

async function answer(omp: OmpHarness, id: string, response: string): Promise<void> {
  await omp.respondToPermission(id, {
    behavior: "allow",
    updatedInput: { answers: { Response: response } },
  });
}

describe("OMP ask RPC UI for an HTML form", () => {
  test("shows each choice field as a card and replays toggles, Other and Done", async () => {
    const omp = new OmpHarness();
    await omp.start();
    startFormAsk(omp);

    expect(omp.pendingPermissions()[0]).toMatchObject({
      kind: "question",
      title: "Session store",
      input: {
        questions: [
          {
            question: "Sessions live in memory & are lost on restart.\n\nSession store",
            options: [
              { label: "SQLite: one file", description: "Recommended" },
              { label: "Redis: shared" },
            ],
            multiSelect: false,
            allowOther: true,
          },
        ],
      },
    });
    await answer(omp, "store", "Postgres");
    omp.emit({
      type: "extension_ui_request",
      id: "store-text",
      method: "input",
      title: "Session store",
    });

    // Alpha is preselected, so OMP's first Extras prompt already counts it.
    select(omp, "extras", "(1 selected) Extras", EXTRAS_ROWS);
    expect(omp.pendingPermissions()[0]?.input?.questions?.[0]).toMatchObject({
      question: "Extras",
      options: [{ label: "Alpha", description: "Recommended" }, { label: "Beta" }],
      multiSelect: true,
      allowOther: true,
    });
    await answer(omp, "extras", "Beta, Gamma");
    select(omp, "extras-2", "Extras", EXTRAS_ROWS);
    select(omp, "extras-3", "(1 selected) Extras", EXTRAS_ROWS);
    omp.emit({ type: "extension_ui_request", id: "extras-text", method: "input", title: "Extras" });
    select(omp, "extras-4", "(2 selected) Extras", EXTRAS_ROWS);

    select(omp, "region", "Region", ["US", "EU"]);
    expect(omp.pendingPermissions()[0]?.input?.questions?.[0]).toMatchObject({
      question: "Region",
      options: [{ label: "US" }, { label: "EU", description: "Recommended" }],
      multiSelect: false,
    });
    expect(omp.pendingPermissions()[0]?.input?.questions?.[0]).not.toHaveProperty("allowOther");
    await answer(omp, "region", "US");

    omp.emit({
      type: "extension_ui_request",
      id: "ttl",
      method: "editor",
      title: "Lifetime (days)",
      prefill: "30",
    });
    expect(omp.pendingPermissions()[0]?.input?.questions?.[0]).toMatchObject({
      question: "Lifetime (days)",
      placeholder: "30",
      allowEmpty: true,
    });
    await answer(omp, "ttl", "");

    expect(omp.pendingPermissions()).toHaveLength(0);
    expect(omp.extensionUiResponses()).toEqual([
      { id: "store", response: { value: "Other (type your own)" } },
      { id: "store-text", response: { value: "Postgres" } },
      { id: "extras", response: { value: "Alpha" } },
      { id: "extras-2", response: { value: "Beta" } },
      { id: "extras-3", response: { value: "Other (type your own)" } },
      { id: "extras-text", response: { value: "Gamma" } },
      { id: "extras-4", response: { value: "✔ Done selecting" } },
      { id: "region", response: { value: "US" } },
      { id: "ttl", response: { value: "30" } },
    ]);
  });

  test("keeps preselected checkboxes the user leaves checked", async () => {
    const omp = new OmpHarness();
    await omp.start();
    startFormAsk(omp);
    await answer(omp, "store", "Redis: shared");
    select(omp, "extras", "(1 selected) Extras", EXTRAS_ROWS);
    await answer(omp, "extras", "Alpha");

    expect(omp.extensionUiResponses()).toEqual([
      { id: "store", response: { value: "Redis: shared" } },
      { id: "extras", response: { value: "✔ Done selecting" } },
    ]);
    expect(omp.pendingPermissions()).toHaveLength(0);
  });

  test("shows the form's answers on the finished ask", async () => {
    const omp = new OmpHarness();
    await omp.start();
    startFormAsk(omp);
    await answer(omp, "store", "Redis: shared");
    omp.emit({
      type: "tool_execution_end",
      toolCallId: "ask-html",
      toolName: "ask",
      result: {
        content: [{ type: "text", text: 'User answers:\n{"store": "redis"}' }],
        details: {
          answers: [
            { name: "store", question: "Session store", answer: "Redis: shared" },
            { name: "extras", question: "Extras", answer: "Alpha, Other: Gamma" },
          ],
        },
      },
      isError: false,
    });

    expect(omp.timeline()).toContainEqual(
      expect.objectContaining({
        type: "tool_call",
        name: "ask",
        detail: {
          type: "plain_text",
          label: "Session store",
          text: "Session store\nRedis: shared\n\nExtras\nAlpha, Other: Gamma",
        },
      }),
    );
  });
});
