import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { projectEquivalenceViewKey } from "../support/helpers/project-view-key";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { openMobileAgentSidebar } from "../support/helpers/sidebar";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

// The app keeps its own copy of the order in this storage key; removing it makes the page a
// device that has never seen these projects.
const LOCAL_ORDER_KEY = "sidebar-project-workspace-order";

function projectRows(page: Page, projects: SeededWorkspace[]): Locator {
  return page.locator(
    projects
      .map(
        (project) =>
          `[data-testid="sidebar-project-row-${projectEquivalenceViewKey(project.projectKey)}"]`,
      )
      .join(", "),
  );
}

async function rowKeys(rows: Locator): Promise<string[]> {
  const ids = await rows.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-testid") ?? ""),
  );
  return ids.map((id) => id.replace("sidebar-project-row-", ""));
}

async function dragFirstRowBelowSecond(rows: Locator): Promise<void> {
  const page = rows.page();
  const source = await rows.nth(0).boundingBox();
  const target = await rows.nth(1).boundingBox();
  if (!source || !target) throw new Error("Expected two visible project rows");
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2 + 7);
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 4 });
  await page.mouse.up();
  // dnd-kit keeps its click blocker for 50 ms after the drop.
  await page.waitForTimeout(60);
}

// Reads the host's order without changing it: a set older than anything stored is refused and
// answered with what the host holds.
async function hostOrder(project: SeededWorkspace): Promise<string[]> {
  const result = await project.client.setSidebarProjectOrder({ order: [], updatedAt: 0 });
  return result.order;
}

function relativeOrder(order: string[], keys: string[]): string[] {
  return order.filter((key) => keys.includes(key));
}

test("a project reorder on one device shows on another, live and after a fresh start", async ({
  page,
}) => {
  const first = await seedWorkspace({ repoPrefix: "order-sync-first-" });
  const second = await seedWorkspace({ repoPrefix: "order-sync-second-" });
  const projects = [first, second];
  const keys = projects.map((project) => projectEquivalenceViewKey(project.projectKey));

  try {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    const rows = projectRows(page, projects);
    await expect(rows).toHaveCount(2);
    const before = await rowKeys(rows);
    const reordered = [before[1], before[0]];

    // Desktop: drag, and the host stores the new order.
    await dragFirstRowBelowSecond(rows);
    await expect.poll(() => rowKeys(rows)).toEqual(reordered);
    await expect.poll(async () => relativeOrder(await hostOrder(first), keys)).toEqual(reordered);

    // A phone that never saw these projects opens with the reordered list.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate((key) => localStorage.removeItem(key), LOCAL_ORDER_KEY);
    await page.reload();
    await openMobileAgentSidebar(page);
    await expect.poll(() => rowKeys(rows)).toEqual(reordered);

    // Another device puts them back; the open phone follows without a reload.
    const stored = await second.client.setSidebarProjectOrder({
      order: before,
      updatedAt: Date.now(),
    });
    expect(stored.accepted).toBe(true);
    await expect.poll(() => rowKeys(rows)).toEqual(before);
    await page.screenshot({ path: test.info().outputPath("compact-synced-order.png") });
  } finally {
    await first.cleanup();
    await second.cleanup();
  }
});
