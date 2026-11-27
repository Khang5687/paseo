import { expect, test, type Page } from "../support/fixtures";
import {
  openAgentRoute,
  seedMockAgentWorkspace,
  type MockAgentWorkspace,
} from "../support/helpers/mock-agent";

// Peek: rest the pointer on a waiting project's rail icon (desktop) or hold its chip (phone),
// answer its question right there, and stay in the chat you had open.

async function seedWaitingAndOpen(prefix: string): Promise<Seeded> {
  const waiting = await seedMockAgentWorkspace({
    repoPrefix: `${prefix}waiting-`,
    title: "Waiting chat",
    initialPrompt: "Plan the invoice email.",
    featureValues: {
      mockAssistantResponses: [
        [
          "Before I send it.",
          "",
          "❓ **Q400** - **Sender name**: which name goes on the invoice email?",
          "",
          "➡️ Fretz Co.",
        ].join("\n"),
        "Thanks.",
      ],
    },
  });
  const current = await seedMockAgentWorkspace({
    repoPrefix: `${prefix}current-`,
    title: "Current chat",
    initialPrompt: "Hello.",
    featureValues: { mockAssistantResponses: ["Hi."] },
  });
  await waiting.client.waitForFinish(waiting.agentId, 30_000);
  await current.client.waitForFinish(current.agentId, 30_000);
  return { waiting, current, waitingPrefix: `${prefix}waiting-` };
}

interface Seeded {
  waiting: MockAgentWorkspace;
  current: MockAgentWorkspace;
  waitingPrefix: string;
}

async function expectAnswerSent(page: Page, seeded: Seeded, before: string, words: string) {
  // Still in the chat we had open.
  expect(page.url()).toBe(before);
  await openAgentRoute(page, seeded.waiting);
  await expect(page.getByTestId("user-message").filter({ hasText: "Q400" })).toContainText(
    `Q400 (Sender name) ${words}`,
    { timeout: 30_000 },
  );
}

test("hovering a waiting project's rail icon answers its question with one click", async ({
  page,
}) => {
  const seeded = await seedWaitingAndOpen("peek-desktop-");
  try {
    await openAgentRoute(page, seeded.current);
    const before = page.url();
    const icon = page.locator(
      `[data-testid^="sidebar-project-rail-item-"][aria-label^="${seeded.waitingPrefix}"]`,
    );
    await expect(icon).toBeVisible({ timeout: 30_000 });
    await icon.hover();
    const peek = page.locator('[data-testid^="sidebar-project-rail-peek-"]').first();
    await expect(peek).toContainText("Sender name", { timeout: 30_000 });
    // Let the card's 80 ms fade-in finish so the screenshot shows it opaque.
    await page.waitForTimeout(200);
    await page.screenshot({ path: test.info().outputPath("peek-desktop.png") });

    const pick = peek.locator('[data-testid$="-pick"]');
    await pick.hover();
    await pick.click();
    // Sending stops the chat waiting; the card stays up to show "Sent".
    await expect(peek.locator('[data-testid$="-sent"]')).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: test.info().outputPath("peek-desktop-sent.png") });
    await page.mouse.move(700, 400);
    await expect(page.locator('[data-testid^="sidebar-project-rail-peek-"]')).toHaveCount(0);
    await expectAnswerSent(page, seeded, before, "yes: Fretz Co.");
  } finally {
    await seeded.waiting.cleanup();
    await seeded.current.cleanup();
  }
});

test.describe("phone width", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("holding a waiting project's chip answers in your own words", async ({ page }) => {
    const seeded = await seedWaitingAndOpen("peek-phone-");
    try {
      await openAgentRoute(page, seeded.current);
      const before = page.url();
      // The menu button works once the chat has loaded; a tap during the spinner is lost.
      await expect(page.getByTestId("user-message").first()).toBeVisible({ timeout: 30_000 });
      await page.getByRole("button", { name: "Open menu", exact: true }).tap();
      const chip = page.locator(
        `[data-testid^="sidebar-project-chip-item-"][aria-label^="${seeded.waitingPrefix}"]`,
      );
      await expect(chip).toBeVisible({ timeout: 30_000 });
      // A long press opens the chip's sheet on a phone; right-click opens the same sheet here.
      await chip.click({ button: "right" });
      const peek = page.locator('[data-testid^="sidebar-project-chip-peek-"]').first();
      await expect(peek).toContainText("Sender name", { timeout: 30_000 });
      await expect(peek.locator('[data-testid$="-open"]')).toBeInViewport();
      await page.screenshot({ path: test.info().outputPath("peek-phone-open.png") });
      await peek.locator('[data-testid$="-text"]').fill("Khang Works");
      await page.screenshot({ path: test.info().outputPath("peek-phone.png") });
      await peek.locator('[data-testid$="-send"]').tap();
      await expect(peek.locator('[data-testid$="-sent"]')).toBeVisible({ timeout: 30_000 });
      await page.screenshot({ path: test.info().outputPath("peek-phone-sent.png") });
      // Tap the dimmed backdrop above the sheet to close it.
      await page.touchscreen.tap(195, 300);
      await expect(page.locator('[data-testid^="sidebar-project-chip-peek-"]')).toHaveCount(0);
      await expectAnswerSent(page, seeded, before, "Khang Works");
    } finally {
      await seeded.waiting.cleanup();
      await seeded.current.cleanup();
    }
  });
});
