import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { primeAdditionalPage } from "../support/helpers/archive-tab";
import { projectEquivalenceViewKey } from "../support/helpers/project-view-key";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";

// Snooze: a project's menu puts it away until tomorrow, Monday or a picked day. It folds into
// "More" on every device, and Wake now brings it back. Desktop by right-click, phone by tap.

async function seedTwoProjects(prefix: string): Promise<[SeededWorkspace, SeededWorkspace]> {
  const alpha = await seedWorkspace({ repoPrefix: `${prefix}alpha-`, title: "Alpha work" });
  const beta = await seedWorkspace({ repoPrefix: `${prefix}beta-`, title: "Beta work" });
  return [alpha, beta];
}

function viewKey(project: SeededWorkspace): string {
  return projectEquivalenceViewKey(project.projectKey);
}

function workspaceRow(page: Page, project: SeededWorkspace): Locator {
  return page.getByTestId(`sidebar-workspace-row-${getServerId()}:${project.workspaceId}`);
}

function railItem(page: Page, project: SeededWorkspace): Locator {
  return page.getByTestId(`sidebar-project-rail-item-${viewKey(project)}`);
}

function chip(page: Page, project: SeededWorkspace): Locator {
  return page.getByTestId(`sidebar-project-chip-item-${viewKey(project)}`);
}

/** The project sits in the fold: hidden with More closed, shown once More opens. */
async function expectFoldedOnRail(page: Page, project: SeededWorkspace): Promise<void> {
  const more = page.getByTestId("sidebar-project-rail-more");
  await expect(more).toBeVisible({ timeout: 30_000 });
  if ((await more.getAttribute("aria-expanded")) === "true") await more.click();
  await expect(railItem(page, project)).toHaveCount(0, { timeout: 30_000 });
  await more.click();
  await expect(
    page
      .getByTestId("sidebar-project-rail-quiet")
      .getByTestId(`sidebar-project-rail-item-${viewKey(project)}`),
  ).toBeVisible();
}

test("snoozes a project from the rail, on every device, and wakes it", async ({ page }) => {
  const [alpha, beta] = await seedTwoProjects("snooze-desktop-");
  const other = await page.context().newPage();
  try {
    await gotoAppShell(page);
    await expect(workspaceRow(page, alpha)).toBeVisible({ timeout: 30_000 });
    await expect(workspaceRow(page, beta)).toBeVisible({ timeout: 30_000 });

    await railItem(page, alpha).click({ button: "right" });
    await page.getByTestId(`sidebar-project-menu-snooze-${viewKey(alpha)}`).click();
    const tomorrow = page.getByTestId(`sidebar-project-snooze-tomorrow-${viewKey(alpha)}`);
    await expect(tomorrow).toBeVisible();
    await page.waitForTimeout(300);
    await page.screenshot({ path: test.info().outputPath("snooze-desktop-menu.png") });
    await tomorrow.click();

    await expectFoldedOnRail(page, alpha);
    await page.screenshot({ path: test.info().outputPath("snooze-desktop-folded.png") });

    // The snooze lives on the host, so a second device folds it too.
    await primeAdditionalPage(other);
    await gotoAppShell(other);
    await expect(workspaceRow(other, beta)).toBeVisible({ timeout: 30_000 });
    await expectFoldedOnRail(other, alpha);

    const folded = page
      .getByTestId("sidebar-project-rail-quiet")
      .getByTestId(`sidebar-project-rail-item-${viewKey(alpha)}`);
    await folded.click({ button: "right" });
    await page.getByTestId(`sidebar-project-menu-snooze-${viewKey(alpha)}`).click();
    await page.getByTestId(`sidebar-project-snooze-wake-${viewKey(alpha)}`).click();
    await expect(
      page
        .getByTestId("sidebar-project-rail-quiet")
        .getByTestId(`sidebar-project-rail-item-${viewKey(alpha)}`),
    ).toHaveCount(0, { timeout: 30_000 });
    await expect(railItem(page, alpha)).toBeVisible();
  } finally {
    await other.close();
    await beta.cleanup();
    await alpha.cleanup();
  }
});

test.describe("phone width", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("snoozes a project to a picked day from its chip", async ({ page }) => {
    const [alpha, beta] = await seedTwoProjects("snooze-phone-");
    try {
      await gotoAppShell(page);
      await page.getByRole("button", { name: "Open menu", exact: true }).tap();
      await expect(chip(page, alpha)).toBeVisible({ timeout: 30_000 });
      await expect(chip(page, beta)).toBeVisible();

      // Long press opens the chip's menu on a phone; right-click is the same menu here.
      await chip(page, alpha).click({ button: "right" });
      await page.getByTestId(`sidebar-project-menu-snooze-${viewKey(alpha)}`).tap();
      await page.getByTestId(`sidebar-project-snooze-date-${viewKey(alpha)}`).tap();
      const day = page.locator(`[data-testid^="sidebar-project-snooze-day-"]`).nth(2);
      await expect(day).toBeVisible();
      await page.screenshot({ path: test.info().outputPath("snooze-phone-dates.png") });
      await day.tap();

      const more = page.getByTestId("sidebar-project-chip-more");
      await expect(more).toBeVisible({ timeout: 30_000 });
      if ((await more.getAttribute("aria-expanded")) === "true") await more.tap();
      await expect(chip(page, alpha)).toHaveCount(0, { timeout: 30_000 });
      await more.tap();
      await expect(chip(page, alpha)).toBeVisible();
      await page.screenshot({ path: test.info().outputPath("snooze-phone-folded.png") });
    } finally {
      await beta.cleanup();
      await alpha.cleanup();
    }
  });
});
