import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { getServerId } from "../support/helpers/server-id";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { openMobileAgentSidebar } from "../support/helpers/sidebar";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

// The app keeps its own copy of the orders and of the sort in these storage keys; removing them
// makes the page a device that has never seen this project.
const LOCAL_ORDER_KEY = "sidebar-project-workspace-order";
const LOCAL_VIEW_KEY = "sidebar-view";

async function rowKeys(rows: Locator): Promise<string[]> {
  const ids = await rows.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-testid") ?? ""),
  );
  return ids.map((id) => id.replace("sidebar-workspace-row-", ""));
}

async function dragFirstRowBelowSecond(rows: Locator): Promise<void> {
  const page = rows.page();
  const source = await rows.nth(0).boundingBox();
  const target = await rows.nth(1).boundingBox();
  if (!source || !target) throw new Error("Expected two visible workspace rows");
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2 + 7);
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 4 });
  await page.mouse.up();
  // dnd-kit keeps its click blocker for 50 ms after the drop.
  await page.waitForTimeout(60);
}

// Reads the host's state without changing it: an empty merge keeps everything it holds.
async function hostState(seed: SeededWorkspace) {
  return seed.client.setSidebarWorkspaceOrder({ projects: {} });
}

async function hostOrderOf(seed: SeededWorkspace, keys: string[]): Promise<string[] | null> {
  const { projects } = await hostState(seed);
  const entry = Object.values(projects).find((project) =>
    keys.every((key) => project.order.includes(key)),
  );
  return entry ? entry.order.filter((key) => keys.includes(key)) : null;
}

function rowsOf(page: Page, keys: string[]): Locator {
  return page.locator(keys.map((key) => `[data-testid="sidebar-workspace-row-${key}"]`).join(", "));
}

test("a workspace drag on one device shows on another, with the sort, live and after a fresh start", async ({
  page,
}) => {
  const seed = await seedWorkspace({ repoPrefix: "workspace-order-sync-" });
  try {
    const newer = await seed.client.createWorkspace({
      source: { kind: "directory", path: seed.repoPath, projectId: seed.projectId },
      title: "Newer workspace",
    });
    if (!newer.workspace) throw new Error(newer.error ?? "Workspace creation failed");
    const older = `${getServerId()}:${seed.workspaceId}`;
    const newest = `${getServerId()}:${newer.workspace.id}`;
    const keys = [older, newest];

    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    const rows = rowsOf(page, keys);
    // Created, the default sort, shows the newest first.
    await expect.poll(() => rowKeys(rows)).toEqual([newest, older]);

    // Desktop: the drag works under Created, switches the sort to Manual, and the host stores both.
    await dragFirstRowBelowSecond(rows);
    await expect.poll(() => rowKeys(rows)).toEqual([older, newest]);
    await expect(page.getByText("Sorted by hand now", { exact: true })).toBeVisible();
    await expect.poll(async () => (await hostState(seed)).sort?.value).toBe("manual");
    await expect.poll(() => hostOrderOf(seed, keys)).toEqual([older, newest]);

    // A phone that never saw this project opens sorted by hand, in the dragged order.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(
      (storageKeys) => {
        for (const key of storageKeys) localStorage.removeItem(key);
      },
      [LOCAL_ORDER_KEY, LOCAL_VIEW_KEY],
    );
    await page.reload();
    await openMobileAgentSidebar(page);
    await expect.poll(() => rowKeys(rows)).toEqual([older, newest]);

    // Another device puts them back; the open phone follows without a reload.
    const projectKey = Object.entries((await hostState(seed)).projects).find(([, project]) =>
      project.order.includes(older),
    )?.[0];
    if (!projectKey) throw new Error("Expected the host to hold the project's order");
    await seed.client.setSidebarWorkspaceOrder({
      projects: { [projectKey]: { order: [newest, older], updatedAt: Date.now() } },
    });
    await expect.poll(() => rowKeys(rows)).toEqual([newest, older]);
    await page.screenshot({ path: test.info().outputPath("compact-synced-workspace-order.png") });
  } finally {
    await seed.cleanup();
  }
});
