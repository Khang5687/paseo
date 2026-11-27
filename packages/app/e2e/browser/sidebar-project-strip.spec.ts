import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { projectEquivalenceViewKey } from "../support/helpers/project-view-key";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";

// theme.colors.palette.purple[500], the same purple as the New main agent dot.
const ASKING_DOT_PURPLE = "rgb(168, 85, 247)";

// One dot per chat: the project asking you shows one purple dot and no number.
async function expectOneAskingDot(item: Locator): Promise<void> {
  const dot = item.getByTestId("sidebar-project-status-dot-needs_input");
  await expect(dot).toHaveCount(1, { timeout: 60_000 });
  await expect(dot).toHaveCSS("background-color", ASKING_DOT_PURPLE);
  await expect(item).toHaveAttribute("aria-label", /Asking you: 1/);
}

// The strip only appears with two or more projects, so every test seeds two.
async function seedTwoProjects(): Promise<[SeededWorkspace, SeededWorkspace]> {
  const alpha = await seedWorkspace({ repoPrefix: "project-strip-alpha-", title: "Alpha work" });
  const beta = await seedWorkspace({ repoPrefix: "project-strip-beta-", title: "Beta work" });
  return [alpha, beta];
}

async function startNeedsInputAgent(project: SeededWorkspace): Promise<void> {
  await project.client.createAgent({
    provider: "mock",
    cwd: project.repoPath,
    workspaceId: project.workspaceId,
    title: "Needs input agent",
    modeId: "load-test",
    model: "thirty-minute-stream",
    initialPrompt: "emit a synthetic plan approval",
  });
}

function workspaceRow(page: Page, project: SeededWorkspace): Locator {
  return page.getByTestId(`sidebar-workspace-row-${getServerId()}:${project.workspaceId}`);
}

function railItem(page: Page, project: SeededWorkspace): Locator {
  return page.getByTestId(
    `sidebar-project-rail-item-${projectEquivalenceViewKey(project.projectKey)}`,
  );
}

function chip(page: Page, project: SeededWorkspace): Locator {
  return page.getByTestId(
    `sidebar-project-chip-item-${projectEquivalenceViewKey(project.projectKey)}`,
  );
}

/**
 * The strip's project keys in on-screen order. With `only`, just those projects: other tests
 * on the same daemon may have projects of their own in the strip.
 */
async function stripOrder(
  page: Page,
  prefix: string,
  only?: readonly SeededWorkspace[],
): Promise<string[]> {
  const ids = await page
    .locator(`[data-testid^="${prefix}"]`)
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-testid") ?? ""));
  const keys = ids.map((id) => id.slice(prefix.length));
  if (!only) return keys;
  const wanted = new Set(only.map((project) => projectEquivalenceViewKey(project.projectKey)));
  return keys.filter((key) => wanted.has(key));
}

async function expectOnlyProjectShown(
  page: Page,
  shown: SeededWorkspace,
  hidden: SeededWorkspace,
): Promise<void> {
  await expect(workspaceRow(page, shown)).toBeVisible({ timeout: 15_000 });
  await expect(workspaceRow(page, hidden)).toHaveCount(0, { timeout: 15_000 });
}

async function screenshot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: test.info().outputPath(name) });
}

async function expectStripOrder(
  page: Page,
  prefix: string,
  only: readonly SeededWorkspace[],
  expected: readonly string[],
): Promise<void> {
  await expect.poll(() => stripOrder(page, prefix, only)).toEqual(expected);
}

async function expectStripIndex(
  page: Page,
  prefix: string,
  key: string,
  index: number,
): Promise<void> {
  await expect.poll(async () => (await stripOrder(page, prefix)).indexOf(key)).toBe(index);
}

test.describe("Sidebar project strip", () => {
  test.describe.configure({ timeout: 180_000 });

  test.describe("desktop rail", () => {
    test.use({ viewport: { width: 1000, height: 800 } });

    test("shows one project, jumps by number, and reorders by drag", async ({ page }) => {
      const [alpha, beta] = await seedTwoProjects();
      try {
        await startNeedsInputAgent(beta);
        await gotoAppShell(page);
        await expect(workspaceRow(page, alpha)).toBeVisible({ timeout: 30_000 });
        await expect(workspaceRow(page, beta)).toBeVisible({ timeout: 30_000 });

        await expectOneAskingDot(railItem(page, beta));
        await expect(railItem(page, beta)).not.toContainText("1");
        await expect(railItem(page, alpha).getByTestId("sidebar-project-status-dots")).toHaveCount(
          0,
        );
        await railItem(page, beta).hover();
        await expect(page.getByText("Asking you: 1")).toBeVisible();
        await screenshot(page, "desktop-rail-dots.png");

        // The open rail writes the exact counts beside the name.
        await page.getByTestId("sidebar-project-rail-toggle").click();
        await expect(railItem(page, beta).getByTestId("sidebar-project-status-counts")).toHaveText(
          "1",
        );
        await page.mouse.move(700, 400);
        await screenshot(page, "desktop-rail-open-counts.png");
        await page.getByTestId("sidebar-project-rail-toggle").click();
        await expect(page.getByTestId("sidebar-project-rail-toggle")).toHaveAttribute(
          "aria-expanded",
          "false",
        );

        await railItem(page, beta).click();
        await expectOnlyProjectShown(page, beta, alpha);
        await expect(railItem(page, beta)).toHaveAttribute("aria-selected", "true");
        await page.mouse.move(700, 400);
        await screenshot(page, "desktop-rail-selected.png");

        // Holding the jump modifier numbers the rail in strip order; on web it is Alt.
        const prefix = "sidebar-project-rail-item-";
        const allKeys = await stripOrder(page, prefix);
        const alphaNumber = allKeys.indexOf(projectEquivalenceViewKey(alpha.projectKey)) + 1;
        expect(alphaNumber).toBeGreaterThan(0);
        expect(alphaNumber).toBeLessThanOrEqual(9);
        await page.keyboard.down("Alt");
        await expect(page.getByTestId("sidebar-project-rail-number")).toHaveCount(
          Math.min(allKeys.length, 9),
        );
        await screenshot(page, "desktop-rail-numbers.png");
        await page.keyboard.press(`Digit${alphaNumber}`);
        await page.keyboard.up("Alt");
        await expectOnlyProjectShown(page, alpha, beta);
        await expect(page.getByTestId("sidebar-project-rail-number")).toHaveCount(0);

        await page.getByTestId("sidebar-project-rail-all").click();
        await expect(workspaceRow(page, alpha)).toBeVisible();
        await expect(workspaceRow(page, beta)).toBeVisible();

        // Drag the later of the two above the earlier; the sidebar list shares the order.
        const before = await stripOrder(page, prefix, [alpha, beta]);
        const [first, second] =
          before[0] === projectEquivalenceViewKey(alpha.projectKey) ? [alpha, beta] : [beta, alpha];
        const fromBox = await railItem(page, second).boundingBox();
        const toBox = await railItem(page, first).boundingBox();
        if (!fromBox || !toBox) throw new Error("rail items have no layout");
        const x = fromBox.x + fromBox.width / 2;
        await page.mouse.move(x, fromBox.y + fromBox.height / 2);
        await page.mouse.down();
        await page.mouse.move(x, toBox.y + 4, { steps: 12 });
        await page.mouse.move(x, toBox.y + 2, { steps: 4 });
        await page.mouse.up();
        await expectStripOrder(page, prefix, [alpha, beta], before.toReversed());
      } finally {
        await beta.cleanup();
        await alpha.cleanup();
      }
    });

    test("opens wide with names, drags there, remembers it, and opens from Reorder projects", async ({
      page,
    }) => {
      const [alpha, beta] = await seedTwoProjects();
      try {
        await gotoAppShell(page);
        await expect(workspaceRow(page, alpha)).toBeVisible({ timeout: 30_000 });
        await expect(workspaceRow(page, beta)).toBeVisible({ timeout: 30_000 });
        const rail = page.getByTestId("sidebar-project-rail");
        const toggle = page.getByTestId("sidebar-project-rail-toggle");

        // Closed, the rail is icons only.
        await expect(railItem(page, alpha)).not.toContainText(alpha.projectDisplayName);
        await toggle.click();
        await expect(toggle).toHaveAttribute("aria-expanded", "true");
        await expect(toggle).toContainText("Collapse");
        await expect(railItem(page, alpha)).toContainText(alpha.projectDisplayName);
        await expect(railItem(page, beta)).toContainText(beta.projectDisplayName);
        const openBox = await rail.boundingBox();
        expect(openBox?.width ?? 0).toBeGreaterThan(150);
        await page.mouse.move(900, 400);
        await screenshot(page, "desktop-rail-open.png");

        // Drag the later of the two above the earlier; the rail stays open.
        const prefix = "sidebar-project-rail-item-";
        const before = await stripOrder(page, prefix, [alpha, beta]);
        const [first, second] =
          before[0] === projectEquivalenceViewKey(alpha.projectKey) ? [alpha, beta] : [beta, alpha];
        const fromBox = await railItem(page, second).boundingBox();
        const toBox = await railItem(page, first).boundingBox();
        if (!fromBox || !toBox) throw new Error("rail items have no layout");
        const x = fromBox.x + fromBox.width / 2;
        await page.mouse.move(x, fromBox.y + fromBox.height / 2);
        await page.mouse.down();
        await page.mouse.move(x, toBox.y + 4, { steps: 12 });
        await page.mouse.move(x, toBox.y + 2, { steps: 4 });
        await page.mouse.up();
        await expectStripOrder(page, prefix, [alpha, beta], before.toReversed());
        await expect(toggle).toHaveAttribute("aria-expanded", "true");

        // The app remembers the rail open.
        await page.reload();
        await expect(railItem(page, alpha)).toContainText(alpha.projectDisplayName, {
          timeout: 30_000,
        });

        await toggle.click();
        await expect(toggle).toHaveAttribute("aria-expanded", "false");
        await expect(railItem(page, alpha)).not.toContainText(alpha.projectDisplayName);
        const closedBox = await rail.boundingBox();
        expect(closedBox?.width ?? 0).toBeLessThan(60);
        await page.mouse.move(900, 400);
        await screenshot(page, "desktop-rail-closed.png");

        // The closed rail's menu: Move to top, and Reorder projects… opens the rail.
        const lastKey = projectEquivalenceViewKey(first.projectKey);
        await railItem(page, first).click({ button: "right" });
        await expect(page.getByTestId(`sidebar-project-rail-menu-${lastKey}`)).toBeVisible();
        await expect(page.getByTestId("sidebar-project-rail-reorder")).toBeInViewport();
        await page.waitForTimeout(300);
        await screenshot(page, "desktop-rail-menu.png");
        await page.getByTestId("sidebar-project-rail-move-top").click();
        await expectStripIndex(page, prefix, lastKey, 0);
        await railItem(page, second).click({ button: "right" });
        await page.getByTestId("sidebar-project-rail-reorder").click();
        await expect(toggle).toHaveAttribute("aria-expanded", "true");
        await expect(railItem(page, second)).toContainText(second.projectDisplayName);
      } finally {
        await beta.cleanup();
        await alpha.cleanup();
      }
    });
  });

  test.describe("compact chip row", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

    test("taps a chip to show one project and moves it from its menu", async ({ page }) => {
      const [alpha, beta] = await seedTwoProjects();
      try {
        await startNeedsInputAgent(beta);
        await gotoAppShell(page);
        await page.getByRole("button", { name: "Open menu", exact: true }).tap();
        await expect(page.getByTestId("sidebar-project-chip-row")).toBeVisible({ timeout: 30_000 });
        await expectOneAskingDot(chip(page, beta));

        await chip(page, beta).tap();
        await expectOnlyProjectShown(page, beta, alpha);
        await expect(chip(page, beta)).toHaveAttribute("aria-selected", "true");
        await screenshot(page, "compact-chip-selected.png");

        await page.getByTestId("sidebar-project-chip-all").tap();
        await expect(workspaceRow(page, alpha)).toBeVisible();
        await expect(workspaceRow(page, beta)).toBeVisible();

        // Phones reorder from the chip's menu (long-press on a phone, right-click here), since a
        // sideways drag on the row scrolls it.
        const prefix = "sidebar-project-chip-item-";
        const mine = await stripOrder(page, prefix, [alpha, beta]);
        const later = mine[1] === projectEquivalenceViewKey(alpha.projectKey) ? alpha : beta;
        const laterKey = projectEquivalenceViewKey(later.projectKey);
        const laterIndex = (await stripOrder(page, prefix)).indexOf(laterKey);
        await chip(page, later).click({ button: "right" });
        // Compact menus open as a sheet; wait for it to finish sliding in.
        await expect(page.getByTestId("sidebar-project-chip-move-earlier")).toBeInViewport({
          ratio: 1,
        });
        await screenshot(page, "compact-chip-menu.png");
        await page.getByTestId("sidebar-project-chip-move-earlier").tap();
        await expectStripIndex(page, prefix, laterKey, laterIndex - 1);
      } finally {
        await beta.cleanup();
        await alpha.cleanup();
      }
    });
  });
});
