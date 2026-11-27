import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { expect, test } from "../support/fixtures";
import { primeAdditionalPage } from "../support/helpers/archive-tab";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

// Withdrawn questions: an agent's reply withdraws its own open questions with ✖️ lines. Every
// questions surface drops them at once (the bar's pill on a second device, Needs you, the purple
// count), a half answer of a withdrawn question is never sent, and the chat shows one gray line per
// withdrawn question that jumps to its replacement. Driven by taps on the phone.

const QUESTIONS_REPLY = [
  "Three things before I build.",
  "",
  "❓ **Q100** - **Strip icons**: round or square?",
  "",
  "➡️ square icons with the project letter",
  "",
  "---",
  "",
  "❓ **Q101** - **Needs you icon**: where does it go?",
  "",
  "➡️ top of the rail, above All",
  "",
  "---",
  "",
  "❓ **Q104** - **Sidebar order**: what do I build first?",
  "",
  "➡️ the project strip first",
].join("\n");

// The notes push the replacement question below the fold at phone height, so the jump has to scroll.
const FOLD_REPLY = [
  "Folding the icon question into the order question.",
  "",
  '✖️ Q100 → Q105: folded into "Sidebar order and icons"',
  "✖️ Q101: dropped, the rail already has it",
  "",
  ...Array.from({ length: 40 }, (_, index) => `Note ${index + 1}: the strip keeps its order.\n`),
  "❓ **Q105** - **Sidebar order and icons**: what do I build first, and with which icons?",
  "",
  "➡️ the project strip first, with square icons",
].join("\n");

const DROP_ALL_REPLY = [
  "You already decided all three in the plan.",
  "",
  "✖️ Q100: dropped, square icons are in the plan",
  "✖️ Q101: dropped, the rail already has it",
  "✖️ Q104: dropped, the strip goes first",
].join("\n");

function openQuestionsOf(snapshot: unknown) {
  return (snapshot as Pick<AgentSnapshotPayload, "openQuestions">).openQuestions ?? [];
}

function halfAnswerOf(snapshot: unknown, id: string): string | undefined {
  return openQuestionsOf(snapshot).find((question) => question.id === id)?.answer?.text;
}

// A second project, because the project strip (rail, chips, Needs you entry) shows from two up.
async function seedAndWithdraw(prefix: string, withdrawReply: string) {
  const idle = await seedMockAgentWorkspace({
    repoPrefix: `idle-${prefix}`,
    title: "Idle chat",
    initialPrompt: "Hello.",
    featureValues: { mockAssistantResponses: ["Hi."] },
  });
  const workspace = await seedMockAgentWorkspace({
    repoPrefix: prefix,
    title: "Withdrawn questions",
    initialPrompt: "Plan the sidebar.",
    featureValues: {
      mockAssistantResponses: [QUESTIONS_REPLY, withdrawReply, "Thanks, building now."],
    },
  });
  await workspace.client.waitForFinish(workspace.agentId, 30_000);
  const withdraw = async () => {
    await workspace.client.sendAgentMessage(workspace.agentId, "Rethink these, fewer please.");
    await workspace.client.waitForAgentUpsert(
      workspace.agentId,
      (snapshot) => !openQuestionsOf(snapshot).some((question) => question.id === "Q100"),
      30_000,
    );
    await workspace.client.waitForFinish(workspace.agentId, 30_000);
  };
  const cleanup = async () => {
    await workspace.cleanup();
    await idle.cleanup();
  };
  return { workspace, withdraw, cleanup };
}

test.describe("phone width", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("a fold leaves one question everywhere, drops the half answer, and the gray line jumps", async ({
    page,
  }) => {
    const { workspace, withdraw, cleanup } = await seedAndWithdraw(
      "withdrawn-questions-phone-",
      FOLD_REPLY,
    );
    const other = await page.context().newPage();
    try {
      await primeAdditionalPage(other);
      await openAgentRoute(other, workspace);
      await expect(other.getByTestId("open-questions-pill")).toContainText("3 open questions", {
        timeout: 30_000,
      });

      await openAgentRoute(page, workspace);
      await expect(page.getByTestId("user-message").first()).toBeVisible({ timeout: 30_000 });
      await page.getByRole("button", { name: "Open menu", exact: true }).tap();
      await page.getByTestId("sidebar-project-chip-needs-you").tap();
      const section = page.getByTestId(`needs-you-chat-${workspace.workspaceId}`);
      await expect(section.getByTestId("open-question-Q100")).toBeVisible({ timeout: 30_000 });
      await section.getByTestId("open-question-Q100-text").fill("round icons");
      await workspace.client.waitForAgentUpsert(
        workspace.agentId,
        (snapshot) => halfAnswerOf(snapshot, "Q100") === "round icons",
        30_000,
      );

      await withdraw();

      await expect(section.getByTestId("open-question-Q105")).toBeVisible({ timeout: 30_000 });
      await expect(section.getByTestId("open-question-Q100")).toHaveCount(0);
      await expect(section.getByTestId("open-question-Q101")).toHaveCount(0);
      await expect(section.getByTestId("open-question-Q104")).toBeVisible();
      await expect(other.getByTestId("open-questions-pill")).toContainText("2 open questions");
      await page.screenshot({ path: test.info().outputPath("withdrawn-needs-you-phone.png") });

      await section.getByTestId("open-question-Q105-pick").tap();
      const send = page.getByTestId("needs-you-send");
      await expect(send).toContainText("Send 1 answer");
      await send.tap();

      await openAgentRoute(page, workspace);
      const sent = page.getByTestId("user-message").filter({ hasText: "Q105" });
      await expect(sent).toContainText("Q105 (Sidebar order and icons) yes", { timeout: 30_000 });
      await expect(sent).not.toContainText("Q100");
      await expect(sent).not.toContainText("round icons");

      const folded = page.getByTestId("withdrawn-question-Q100");
      await expect(folded).toHaveText("Q100 withdrawn → Q105");
      await expect(page.getByTestId("withdrawn-question-Q101")).toHaveText("Q101 withdrawn");
      await folded.scrollIntoViewIfNeeded();
      await expect(folded).toBeInViewport();
      await page.screenshot({ path: test.info().outputPath("withdrawn-lines-phone.png") });
      const replacement = page.getByText("what do I build first, and with which icons?");
      await expect(replacement).not.toBeInViewport();
      await folded.tap();
      await expect(replacement).toBeInViewport({ timeout: 10_000 });
      await page.screenshot({ path: test.info().outputPath("withdrawn-jump-phone.png") });
    } finally {
      await other.close();
      await cleanup();
    }
  });
});

test("withdrawing every question clears the pill, the peek and the Needs you count", async ({
  page,
}) => {
  const { workspace, withdraw, cleanup } = await seedAndWithdraw(
    "withdrawn-questions-desktop-",
    DROP_ALL_REPLY,
  );
  try {
    await openAgentRoute(page, workspace);
    await expect(page.getByTestId("open-questions-pill")).toContainText("3 open questions", {
      timeout: 30_000,
    });
    const count = page
      .getByTestId("sidebar-project-rail-needs-you")
      .getByTestId("sidebar-needs-you-count");
    await expect(count).toBeVisible({ timeout: 30_000 });
    const icon = page.locator(
      '[data-testid^="sidebar-project-rail-item-"][aria-label^="withdrawn-questions-desktop-"]',
    );
    await icon.hover();
    const peek = page.locator('[data-testid^="sidebar-project-rail-peek-"]').first();
    await expect(peek).toContainText("Q100 · Strip icons", { timeout: 30_000 });

    await withdraw();

    await expect(peek).toHaveCount(0, { timeout: 30_000 });
    await page.mouse.move(700, 400);
    await expect(page.getByTestId("open-questions-pill")).toHaveCount(0);
    await expect(count).toHaveCount(0);
    await expect(page.getByTestId("withdrawn-question-Q104")).toHaveText("Q104 withdrawn");
    await page.screenshot({ path: test.info().outputPath("withdrawn-lines-desktop.png") });
  } finally {
    await cleanup();
  }
});
