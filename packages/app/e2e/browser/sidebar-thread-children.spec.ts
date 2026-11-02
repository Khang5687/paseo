import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { sheet } from "../support/helpers/sheet";
import {
  expectMobileAgentSidebarVisible,
  openMobileAgentSidebar,
} from "../support/helpers/sidebar";
import { seedParentWithCrossWorkspaceSubagent, seedSubagent } from "../support/helpers/subagents";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test("a thread folds its subagents under its sidebar row and unfolds them on tap", async ({
  page,
}, testInfo) => {
  const seeded = await seedWorkspace({
    repoPrefix: "sidebar-thread-children-",
    title: "Parent workspace",
  });
  try {
    const pair = await seedParentWithCrossWorkspaceSubagent(seeded, {
      parentTitle: "Orchestrator",
      childTitle: "Remote helper",
    });
    const sameWorkspaceChild = await seedSubagent(seeded, {
      parentId: pair.parent.id,
      title: "Local helper",
    });
    const serverId = getServerId();
    const parentKey = `${serverId}:${pair.parent.workspaceId}`;

    await gotoAppShell(page);
    await openMobileAgentSidebar(page);
    await expectMobileAgentSidebarVisible(page);
    await waitForSidebarHydration(page);

    const parentRow = page.getByTestId(`sidebar-workspace-row-${parentKey}`);
    const childWorkspaceRow = page.getByTestId(
      `sidebar-workspace-row-${serverId}:${pair.child.workspaceId}`,
    );
    const localChildRow = page.getByTestId(`sidebar-thread-child-paseo-${sameWorkspaceChild.id}`);
    const fold = page.getByTestId(`sidebar-thread-children-toggle-${parentKey}`);

    // Folded by default: one count for the same-workspace child and the subagent workspace.
    await expect(parentRow).toBeVisible({ timeout: 30_000 });
    await expect(fold).toHaveAccessibleName("2 subagents", { timeout: 30_000 });
    await expect(childWorkspaceRow).toHaveCount(0);
    await expect(localChildRow).toHaveCount(0);

    await fold.tap();
    await expect(localChildRow).toBeVisible();
    await expect(localChildRow).toHaveAccessibleName("Local helper");
    await expect(childWorkspaceRow).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("sidebar-thread-unfolded.png") });

    // The unfolded state is remembered for this thread across a reload.
    await page.reload();
    await openMobileAgentSidebar(page);
    await waitForSidebarHydration(page);
    await expect(localChildRow).toBeVisible({ timeout: 30_000 });

    // On a phone a subagent opens in a sheet over its parent's workspace, as from the track.
    await localChildRow.tap();
    await expect(page).toHaveURL((url) =>
      url.pathname.endsWith(`/workspace/${pair.parent.workspaceId}`),
    );
    await expect(sheet(page, "Local helper")).toBeVisible();
  } finally {
    await seeded.cleanup();
  }
});
