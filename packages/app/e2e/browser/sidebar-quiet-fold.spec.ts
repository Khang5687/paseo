import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { projectEquivalenceViewKey } from "../support/helpers/project-view-key";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";

const QUIET_DAYS = 4;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Moves the page's clock four days ahead, so everything the daemon reports happened four days
 * ago. Only `Date.now` moves: the app reads it for "now" and parses daemon timestamps as given.
 */
async function moveClockAhead(page: Page): Promise<void> {
  await page.addInitScript((offsetMs) => {
    const realNow = Date.now.bind(Date);
    Date.now = () => realNow() + offsetMs;
  }, QUIET_DAYS * DAY_MS);
}

async function seedQuietAndWaiting(): Promise<[SeededWorkspace, SeededWorkspace]> {
  const quiet = await seedWorkspace({ repoPrefix: "quiet-fold-quiet-", title: "Quiet work" });
  const waiting = await seedWorkspace({ repoPrefix: "quiet-fold-waiting-", title: "Waiting work" });
  await waiting.client.createAgent({
    provider: "mock",
    cwd: waiting.repoPath,
    workspaceId: waiting.workspaceId,
    title: "Needs input agent",
    modeId: "load-test",
    model: "thirty-minute-stream",
    initialPrompt: "emit a synthetic plan approval",
  });
  return [quiet, waiting];
}

function workspaceRow(page: Page, project: SeededWorkspace): Locator {
  return page.getByTestId(`sidebar-workspace-row-${getServerId()}:${project.workspaceId}`);
}

function stripItem(page: Page, kind: "rail" | "chip", project: SeededWorkspace): Locator {
  return page.getByTestId(
    `sidebar-project-${kind}-item-${projectEquivalenceViewKey(project.projectKey)}`,
  );
}

test.describe("Quiet projects fold into More", () => {
  test.use({ viewport: { width: 1000, height: 800 } });

  test("a quiet project folds on the rail and in the list; one waiting on you stays", async ({
    page,
  }) => {
    const [quiet, waiting] = await seedQuietAndWaiting();
    try {
      await moveClockAhead(page);
      await gotoAppShell(page);

      await expect(stripItem(page, "rail", waiting)).toBeVisible({ timeout: 30_000 });
      await expect(workspaceRow(page, waiting)).toBeVisible();
      await expect(stripItem(page, "rail", quiet)).toHaveCount(0, { timeout: 30_000 });
      await expect(workspaceRow(page, quiet)).toHaveCount(0);
      await expect(page.getByTestId("sidebar-project-rail-more")).toBeVisible();
      await expect(page.getByTestId("sidebar-quiet-fold-row")).toContainText("More · ");
      await page.screenshot({ path: test.info().outputPath("desktop-quiet-fold.png") });

      await page.getByTestId("sidebar-project-rail-more").click();
      await expect(stripItem(page, "rail", quiet)).toBeVisible();
      await expect(workspaceRow(page, quiet)).toBeVisible();
    } finally {
      await quiet.cleanup();
      await waiting.cleanup();
    }
  });

  test.describe("compact", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

    test("the chip row folds a quiet project behind More", async ({ page }) => {
      const [quiet, waiting] = await seedQuietAndWaiting();
      try {
        await moveClockAhead(page);
        await gotoAppShell(page);
        await page.getByRole("button", { name: "Open menu", exact: true }).tap();

        await expect(stripItem(page, "chip", waiting)).toBeVisible({ timeout: 30_000 });
        await expect(stripItem(page, "chip", quiet)).toHaveCount(0, { timeout: 30_000 });
        const more = page.getByTestId("sidebar-project-chip-more");
        await expect(more).toBeVisible();
        await expect(workspaceRow(page, waiting)).toBeVisible();
        await expect(workspaceRow(page, quiet)).toHaveCount(0);
        await expect(page.getByTestId("sidebar-quiet-fold-row")).toBeVisible();
        await page.screenshot({ path: test.info().outputPath("compact-quiet-fold.png") });

        await more.tap();
        await expect(stripItem(page, "chip", quiet)).toBeVisible();
      } finally {
        await quiet.cleanup();
        await waiting.cleanup();
      }
    });
  });
});
