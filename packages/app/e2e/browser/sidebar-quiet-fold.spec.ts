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

/** A pinned project never folds, however quiet. */
async function seedPinned(repoPrefix: string): Promise<SeededWorkspace> {
  const seeded = await seedWorkspace({ repoPrefix, title: "Pinned work" });
  await seeded.client.setWorkspacePinned(seeded.workspaceId, true);
  return seeded;
}

async function cleanupAll(projects: SeededWorkspace[]): Promise<void> {
  await Promise.all(projects.map((project) => project.cleanup()));
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
      // Two pinned projects with long names push "More" to the row's end, so the chips it
      // opens land past the right edge unless the row scrolls to them.
      const pinned = await Promise.all([
        seedPinned("quiet-fold-pinned-long-name-a-"),
        seedPinned("quiet-fold-pinned-long-name-b-"),
      ]);
      // A quiet project with only a background workspace: the list hides it while "Show
      // background" is off, so the chip row must not count it either.
      const background = await seedWorkspace({
        repoPrefix: "quiet-fold-background-",
        title: "Background work",
        background: true,
      });
      try {
        await moveClockAhead(page);
        await gotoAppShell(page);
        await page.getByRole("button", { name: "Open menu", exact: true }).tap();

        await expect(stripItem(page, "chip", waiting)).toBeVisible({ timeout: 30_000 });
        await expect(stripItem(page, "chip", quiet)).toHaveCount(0, { timeout: 30_000 });
        for (const project of pinned) {
          await expect(stripItem(page, "chip", project)).toBeVisible();
        }
        const more = page.getByTestId("sidebar-project-chip-more");
        const listMore = page.getByTestId("sidebar-quiet-fold-row");
        await expect(more).toBeVisible();
        await expect(workspaceRow(page, waiting)).toBeVisible();
        await expect(workspaceRow(page, quiet)).toHaveCount(0);
        await expect(listMore).toBeVisible();
        const listCount = (await listMore.innerText()).match(/(\d+) quiet/)?.[1];
        expect(listCount).toBeDefined();
        await expect(more).toContainText(`${listCount} quiet`);
        await page.screenshot({ path: test.info().outputPath("compact-quiet-fold.png") });

        await more.tap();
        await expect(more).toHaveAttribute("aria-expanded", "true");
        // Whole chips, not a sliver at the edge: the row has finished scrolling to them.
        await expect(stripItem(page, "chip", quiet)).toBeInViewport({ ratio: 1 });
        await expect(more).toBeInViewport({ ratio: 1 });
        await expect(stripItem(page, "chip", background)).toHaveCount(0);
        await page.screenshot({ path: test.info().outputPath("compact-quiet-open.png") });
      } finally {
        await quiet.cleanup();
        await waiting.cleanup();
        await background.cleanup();
        await cleanupAll(pinned);
      }
    });
  });
});
