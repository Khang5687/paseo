import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { projectEquivalenceViewKey } from "../support/helpers/project-view-key";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";

// The strip only appears with two or more projects, so every test seeds two.
async function seedTwoProjects(): Promise<[SeededWorkspace, SeededWorkspace]> {
  const alpha = await seedWorkspace({ repoPrefix: "last-chat-alpha-", title: "Alpha work" });
  const beta = await seedWorkspace({ repoPrefix: "last-chat-beta-", title: "Beta work" });
  return [alpha, beta];
}

function workspaceRow(page: Page, project: SeededWorkspace): Locator {
  return page.getByTestId(`sidebar-workspace-row-${getServerId()}:${project.workspaceId}`);
}

function viewKey(project: SeededWorkspace): string {
  return projectEquivalenceViewKey(project.projectKey);
}

async function expectOpenWorkspace(page: Page, project: SeededWorkspace): Promise<void> {
  await expect
    .poll(() => decodeURIComponent(new URL(page.url()).pathname), { timeout: 30_000 })
    .toContain(`/workspace/${project.workspaceId}`);
}

async function expectOnlyProjectShown(
  page: Page,
  shown: SeededWorkspace,
  hidden: SeededWorkspace,
): Promise<void> {
  await expect(workspaceRow(page, shown)).toBeVisible({ timeout: 15_000 });
  await expect(workspaceRow(page, hidden)).toHaveCount(0, { timeout: 15_000 });
}

async function railNumber(page: Page, project: SeededWorkspace): Promise<number> {
  const prefix = "sidebar-project-rail-item-";
  const ids = await page
    .locator(`[data-testid^="${prefix}"]`)
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-testid") ?? ""));
  return ids.map((id) => id.slice(prefix.length)).indexOf(viewKey(project)) + 1;
}

async function screenshot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: test.info().outputPath(name) });
}

test.describe("Project strip last chat", () => {
  test.describe.configure({ timeout: 180_000 });

  test.describe("desktop rail", () => {
    test.use({ viewport: { width: 1000, height: 800 } });

    test("a project jump reopens the chat you last had open there", async ({ page }) => {
      const [alpha, beta] = await seedTwoProjects();
      try {
        await gotoAppShell(page);
        await workspaceRow(page, alpha).click({ timeout: 30_000 });
        await expectOpenWorkspace(page, alpha);
        await workspaceRow(page, beta).click();
        await expectOpenWorkspace(page, beta);

        // On web the project jump is Alt+digit.
        const alphaNumber = await railNumber(page, alpha);
        expect(alphaNumber).toBeGreaterThan(0);
        expect(alphaNumber).toBeLessThanOrEqual(9);
        await page.keyboard.press(`Alt+Digit${alphaNumber}`);
        await expectOnlyProjectShown(page, alpha, beta);
        await expectOpenWorkspace(page, alpha);
        await page.mouse.move(700, 400);
        await screenshot(page, "desktop-last-chat-jump.png");

        // A rail click does the same.
        await page.getByTestId(`sidebar-project-rail-item-${viewKey(beta)}`).click();
        await expectOnlyProjectShown(page, beta, alpha);
        await expectOpenWorkspace(page, beta);
      } finally {
        await beta.cleanup();
        await alpha.cleanup();
      }
    });
  });

  test.describe("compact chip row", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

    test("a chip tap only changes the list and marks the last open chat", async ({ page }) => {
      const [alpha, beta] = await seedTwoProjects();
      const openMenu = page.getByRole("button", { name: "Open menu", exact: true });
      try {
        await gotoAppShell(page);
        await openMenu.tap();
        await workspaceRow(page, alpha).tap({ timeout: 30_000 });
        await expectOpenWorkspace(page, alpha);
        await openMenu.tap();
        await workspaceRow(page, beta).tap();
        await expectOpenWorkspace(page, beta);
        await openMenu.tap();

        await page.getByTestId(`sidebar-project-chip-item-${viewKey(alpha)}`).tap();
        await expectOnlyProjectShown(page, alpha, beta);
        await expectOpenWorkspace(page, beta);
        await expect(
          workspaceRow(page, alpha).getByTestId("sidebar-workspace-last-open"),
        ).toBeVisible();
        await screenshot(page, "compact-last-open.png");

        await workspaceRow(page, alpha).tap();
        await expectOpenWorkspace(page, alpha);
      } finally {
        await beta.cleanup();
        await alpha.cleanup();
      }
    });
  });
});
