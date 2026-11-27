import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { expect, test, type Page } from "../support/fixtures";
import { primeAdditionalPage } from "../support/helpers/archive-tab";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

// The questions bar: an agent's ❓ questions become cards above the composer, one Send answers the
// answered ones in one message, and a half answer shows on a second device. Driven by taps.

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

// What Send would send for Q100 (picked) and Q104 (typed), which Copy answers must match.
const EXPECTED_COPY = [
  "Q100 (Strip icons) yes: square icons with the project letter",
  "Q104 (Sidebar order) round chips first",
].join("\n");

function readClipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

async function seedQuestions(prefix: string) {
  const workspace = await seedMockAgentWorkspace({
    repoPrefix: prefix,
    title: "Questions bar",
    initialPrompt: "Plan the sidebar.",
    featureValues: { mockAssistantResponses: [QUESTIONS_REPLY, "Thanks, building now."] },
  });
  await workspace.client.waitForFinish(workspace.agentId, 30_000);
  return workspace;
}

async function openQuestions(page: Page) {
  const pill = page.getByTestId("open-questions-pill");
  await expect(pill).toContainText("3 open questions", { timeout: 30_000 });
  await pill.click();
  await expect(page.getByTestId("open-question-Q100")).toBeVisible();
}

test.describe("phone width", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("sends the answered cards in one message and keeps the skipped one open", async ({
    page,
  }) => {
    const workspace = await seedQuestions("open-questions-phone-");
    try {
      await openAgentRoute(page, workspace);
      const pill = page.getByTestId("open-questions-pill");
      await expect(pill).toContainText("3 open questions", { timeout: 30_000 });
      await pill.tap();

      await page.getByTestId("open-question-Q100-pick").tap();
      await expect(page.getByTestId("open-question-Q100-answered")).toBeVisible();
      await page.getByTestId("open-question-Q104-text").fill("round chips first");
      await expect(page.getByTestId("open-questions-summary")).toHaveText(
        "2 of 3 answered · 1 stay open",
      );
      await page.screenshot({ path: test.info().outputPath("questions-bar-phone.png") });
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
      const copy = page.getByTestId("open-questions-copy");
      await copy.tap();
      await expect(copy).toHaveText("Copied");
      await page.screenshot({ path: test.info().outputPath("questions-copy-phone.png") });
      await expect.poll(() => readClipboard(page)).toBe(EXPECTED_COPY);

      await page.getByTestId("open-questions-send").tap();
      const sent = page.getByTestId("user-message").filter({ hasText: "Q100 (Strip icons)" });
      await expect(sent).toContainText(
        "Q100 (Strip icons) yes: square icons with the project letter",
      );
      await expect(sent).toContainText("Q104 (Sidebar order) round chips first");
      await expect(sent).not.toContainText("Q101");

      await workspace.client.waitForFinish(workspace.agentId, 30_000);
      await expect(page.getByTestId("open-questions-pill")).toContainText("1 open question", {
        timeout: 30_000,
      });
      await page.screenshot({ path: test.info().outputPath("questions-bar-phone-after.png") });
    } finally {
      await workspace.cleanup();
    }
  });
});

test("Copy answers copies what Send would send and leaves every question open", async ({
  page,
}) => {
  const workspace = await seedQuestions("open-questions-copy-");
  try {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await openAgentRoute(page, workspace);
    await openQuestions(page);
    const copy = page.getByTestId("open-questions-copy");
    await expect(copy).toBeDisabled();

    await page.getByTestId("open-question-Q100-pick").click();
    await page.getByTestId("open-question-Q104-text").fill("round chips first");
    await expect(copy).toBeEnabled();
    await page.screenshot({ path: test.info().outputPath("questions-copy-desktop.png") });

    await copy.click();
    await expect(copy).toHaveText("Copied");
    await page.screenshot({ path: test.info().outputPath("questions-copy-desktop-after.png") });
    await expect.poll(() => readClipboard(page)).toBe(EXPECTED_COPY);
    await expect(page.getByTestId("open-questions-summary")).toHaveText(
      "2 of 3 answered · 1 stay open",
    );
    await expect(page.getByTestId("user-message").filter({ hasText: "Q100" })).toHaveCount(0);
    await expect(copy).toHaveText("Copy answers", { timeout: 5_000 });
  } finally {
    await workspace.cleanup();
  }
});

test("a half answer shows on a second device", async ({ page }) => {
  const workspace = await seedQuestions("open-questions-sync-");
  const other = await page.context().newPage();
  try {
    await primeAdditionalPage(other);
    await openAgentRoute(page, workspace);
    await openQuestions(page);
    await page.getByTestId("open-question-Q101-pick").click();
    await page.getByTestId("open-question-Q104-text").fill("round chips first");
    await page.screenshot({ path: test.info().outputPath("questions-bar-desktop.png") });

    await workspace.client.waitForAgentUpsert(
      workspace.agentId,
      (snapshot) =>
        (snapshot as Pick<AgentSnapshotPayload, "openQuestions">).openQuestions?.find(
          (question) => question.id === "Q104",
        )?.answer?.text === "round chips first",
      30_000,
    );

    await openAgentRoute(other, workspace);
    await openQuestions(other);
    await expect(other.getByTestId("open-question-Q101-answered")).toBeVisible();
    await expect(other.getByTestId("open-questions-summary")).toHaveText(
      "2 of 3 answered · 1 stay open",
    );
  } finally {
    await other.close();
    await workspace.cleanup();
  }
});
