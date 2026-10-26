import type { Locator } from "@playwright/test";
import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import {
  expectMobileAgentSidebarVisible,
  openMobileAgentSidebar,
} from "../support/helpers/sidebar";
import { seedParentWithCrossWorkspaceSubagent } from "../support/helpers/subagents";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

const CHILD_WORKSPACE_TITLE = "Subagent workspace";
const SIBLING_WORKSPACE_TITLE = "Sibling workspace";

function rowTestId(workspaceId: string): string {
  return `sidebar-workspace-row-${getServerId()}:${workspaceId}`;
}

async function titleLeft(row: Locator, title: string): Promise<number> {
  const box = await row.getByText(title, { exact: true }).boundingBox();
  if (!box) throw new Error(`workspace title "${title}" has no bounds`);
  return box.x;
}

async function sidebarRowOrder(page: Page, workspaceIds: string[]): Promise<string[]> {
  const wanted = new Set(workspaceIds.map(rowTestId));
  const ids = await page
    .locator('[data-testid^="sidebar-workspace-row-"]')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-testid") ?? ""));
  return ids.filter((id) => wanted.has(id));
}

test("a subagent's workspace sits indented under its parent's workspace and opens on tap", async ({
  page,
}) => {
  const seeded = await seedWorkspace({
    repoPrefix: "subagent-workspace-nesting-",
    title: "Parent workspace",
  });
  try {
    const pair = await seedParentWithCrossWorkspaceSubagent(seeded, {
      parentTitle: "Orchestrator",
      childTitle: "Helper",
    });
    // A workspace of the same project with no parent agent stays top-level.
    const sibling = await seeded.client.createWorkspace({
      source: { kind: "directory", path: seeded.repoPath, projectId: seeded.projectId },
      title: SIBLING_WORKSPACE_TITLE,
    });
    if (!sibling.workspace) throw new Error(sibling.error ?? "Failed to create sibling workspace");
    const siblingId = sibling.workspace.id;

    await gotoAppShell(page);
    await openMobileAgentSidebar(page);
    await expectMobileAgentSidebarVisible(page);
    await waitForSidebarHydration(page);

    const parentRow = page.getByTestId(rowTestId(pair.parent.workspaceId));
    const childRow = page.getByTestId(rowTestId(pair.child.workspaceId));
    const siblingRow = page.getByTestId(rowTestId(siblingId));
    await expect(parentRow).toBeVisible({ timeout: 30_000 });
    await expect(childRow).toBeVisible({ timeout: 30_000 });
    await expect(siblingRow).toBeVisible({ timeout: 30_000 });

    // The child row follows its parent row directly, ahead of the unrelated workspace.
    const ids = [pair.parent.workspaceId, pair.child.workspaceId, siblingId];
    await expect
      .poll(async () => {
        const order = await sidebarRowOrder(page, ids);
        return (
          order.indexOf(rowTestId(pair.child.workspaceId)) -
          order.indexOf(rowTestId(pair.parent.workspaceId))
        );
      })
      .toBe(1);

    // The child is indented past its parent; a top-level sibling is not.
    const parentLeft = await titleLeft(parentRow, seeded.workspaceName);
    const siblingLeft = await titleLeft(siblingRow, SIBLING_WORKSPACE_TITLE);
    await expect
      .poll(async () => (await titleLeft(childRow, CHILD_WORKSPACE_TITLE)) - parentLeft)
      .toBeGreaterThanOrEqual(8);
    expect(siblingLeft).toBe(parentLeft);

    await childRow.tap();
    await expect(page).toHaveURL(new RegExp(`/workspace/${pair.child.workspaceId}`));
  } finally {
    await seeded.cleanup();
  }
});
