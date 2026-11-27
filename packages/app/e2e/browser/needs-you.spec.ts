import { expect, test, type Page } from "../support/fixtures";
import {
  openAgentRoute,
  seedMockAgentWorkspace,
  type MockAgentWorkspace,
} from "../support/helpers/mock-agent";

// Needs you: two chats in two projects end with ❓ questions. The page lists both, one Send sends
// each chat only its own answers, and the skipped card stays. Driven by taps.

function questionsReply(cards: { label: string; title: string; pick: string }[]): string {
  return [
    "Before I go on.",
    "",
    ...cards.flatMap((card, index) => [
      ...(index > 0 ? ["---", ""] : []),
      `❓ **${card.label}** - **${card.title}**: which one?`,
      "",
      `➡️ ${card.pick}`,
      "",
    ]),
  ].join("\n");
}

async function seedTwoWaitingChats(prefix: string): Promise<Seeded> {
  const alpha = await seedMockAgentWorkspace({
    repoPrefix: `${prefix}alpha-`,
    title: "Alpha chat",
    initialPrompt: "Plan alpha.",
    featureValues: {
      mockAssistantResponses: [
        questionsReply([
          { label: "Q200", title: "Alpha colors", pick: "blue" },
          { label: "Q201", title: "Alpha fonts", pick: "serif" },
        ]),
        "Thanks.",
      ],
    },
  });
  const beta = await seedMockAgentWorkspace({
    repoPrefix: `${prefix}beta-`,
    title: "Beta chat",
    initialPrompt: "Plan beta.",
    featureValues: {
      mockAssistantResponses: [
        questionsReply([{ label: "Q300", title: "Beta layout", pick: "grid" }]),
        "Thanks.",
      ],
    },
  });
  await alpha.client.waitForFinish(alpha.agentId, 30_000);
  await beta.client.waitForFinish(beta.agentId, 30_000);
  return { alpha, beta };
}

interface Seeded {
  alpha: MockAgentWorkspace;
  beta: MockAgentWorkspace;
}

function readClipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

async function answerAndSend(page: Page, { alpha, beta }: Seeded, tap: boolean) {
  const alphaSection = page.getByTestId(`needs-you-chat-${alpha.workspaceId}`);
  const betaSection = page.getByTestId(`needs-you-chat-${beta.workspaceId}`);
  await expect(alphaSection).toBeVisible({ timeout: 30_000 });
  await expect(betaSection).toBeVisible();
  await expect(alphaSection.getByTestId("open-question-Q201")).toBeVisible();

  const pick = alphaSection.getByTestId("open-question-Q200-pick");
  await (tap ? pick.tap() : pick.click());
  await expect(alphaSection.getByTestId("open-question-Q200-answered")).toBeVisible();
  await betaSection.getByTestId("open-question-Q300-text").fill("cards in a list");
  await page.screenshot({ path: test.info().outputPath("needs-you.png") });

  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const copy = page.getByTestId("needs-you-copy");
  await (tap ? copy.tap() : copy.click());
  await expect(copy).toContainText("Copied");
  await page.screenshot({ path: test.info().outputPath("needs-you-copied.png") });
  // Each chat's own lines under its heading ("project › chat"); the skipped card is not in it,
  // and nothing was sent.
  await expect
    .poll(() => readClipboard(page))
    .toMatch(/^[^\n]+ › [^\n]+\nQ200 \(Alpha colors\) yes: blue\n\n[^\n]+ › [^\n]+\nQ300 /);
  const copiedText = await readClipboard(page);
  expect(copiedText).toContain("Q300 (Beta layout) cards in a list");
  expect(copiedText).not.toContain("Q201");
  await expect(alphaSection.getByTestId("open-question-Q200-answered")).toBeVisible();

  const send = page.getByTestId("needs-you-send");
  await expect(send).toContainText("Send 2 answers");
  await (tap ? send.tap() : send.click());
  await expect(alphaSection.getByTestId("open-question-Q200-answered")).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(alphaSection.getByTestId("open-question-Q201")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("needs-you-after.png") });
}

async function expectOwnAnswersOnly(page: Page, { alpha, beta }: Seeded) {
  await openAgentRoute(page, alpha);
  const alphaSent = page.getByTestId("user-message").filter({ hasText: "Q200" });
  await expect(alphaSent).toContainText("Q200 (Alpha colors) yes: blue", { timeout: 30_000 });
  await expect(alphaSent).not.toContainText("Q201");
  await expect(alphaSent).not.toContainText("Q300");

  await openAgentRoute(page, beta);
  const betaSent = page.getByTestId("user-message").filter({ hasText: "Q300" });
  await expect(betaSent).toContainText("Q300 (Beta layout) cards in a list", { timeout: 30_000 });
  await expect(betaSent).not.toContainText("Q200");
}

test("one Send answers two chats from the rail's Needs you", async ({ page }) => {
  const seeded = await seedTwoWaitingChats("needs-you-desktop-");
  try {
    await openAgentRoute(page, seeded.alpha);
    const rail = page.getByTestId("sidebar-project-rail-needs-you");
    await expect(rail.getByTestId("sidebar-needs-you-count")).toBeVisible({ timeout: 30_000 });
    await rail.click();
    await answerAndSend(page, seeded, false);
    await expectOwnAnswersOnly(page, seeded);
  } finally {
    await seeded.alpha.cleanup();
    await seeded.beta.cleanup();
  }
});

test.describe("phone width", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("the first chip opens Needs you and one Send answers both chats", async ({ page }) => {
    const seeded = await seedTwoWaitingChats("needs-you-phone-");
    try {
      await openAgentRoute(page, seeded.alpha);
      // The menu button works once the chat has loaded; a tap during the spinner is lost.
      await expect(page.getByTestId("user-message").first()).toBeVisible({ timeout: 30_000 });
      await page.getByRole("button", { name: "Open menu", exact: true }).tap();
      const chip = page.getByTestId("sidebar-project-chip-needs-you");
      await expect(chip).toBeVisible();
      await expect(chip.getByTestId("sidebar-needs-you-chip-count")).toBeVisible({
        timeout: 30_000,
      });
      await page.screenshot({ path: test.info().outputPath("needs-you-chip.png") });
      await chip.tap();
      await answerAndSend(page, seeded, true);
      await expectOwnAnswersOnly(page, seeded);
    } finally {
      await seeded.alpha.cleanup();
      await seeded.beta.cleanup();
    }
  });
});
