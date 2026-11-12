import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { sheet } from "../support/helpers/sheet";
import {
  expectMobileAgentSidebarVisible,
  openMobileAgentSidebar,
} from "../support/helpers/sidebar";
import {
  seedParentWithCrossWorkspaceSubagent,
  seedRunningSubagent,
  seedSubagent,
} from "../support/helpers/subagents";
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

test("subagents nest under their spawner and one action archives every finished one", async ({
  page,
}, testInfo) => {
  const seeded = await seedWorkspace({ repoPrefix: "sidebar-thread-tree-", title: "Tree thread" });
  try {
    const parent = await seeded.client.createAgent({
      provider: "mock",
      cwd: seeded.repoPath,
      workspaceId: seeded.workspaceId,
      title: "Tree orchestrator",
      modeId: "load-test",
      model: "ten-second-stream",
    });
    const child = await seedSubagent(seeded, { parentId: parent.id, title: "Tree child" });
    const grandchild = await seedSubagent(seeded, {
      parentId: child.id,
      title: "Tree grandchild",
    });
    const busy = await seedRunningSubagent(seeded, { parentId: parent.id, title: "Tree busy" });
    for (const id of [child.id, grandchild.id]) {
      await seeded.client.waitForAgentUpsert(id, (snapshot) => snapshot.status === "idle");
    }
    const parentKey = `${getServerId()}:${seeded.workspaceId}`;

    await gotoAppShell(page);
    await openMobileAgentSidebar(page);
    await waitForSidebarHydration(page);

    const fold = page.getByTestId(`sidebar-thread-children-toggle-${parentKey}`);
    await expect(fold).toHaveAccessibleName("3 subagents", { timeout: 30_000 });
    await fold.tap();

    const childRow = page.getByTestId(`sidebar-thread-child-paseo-${child.id}`);
    const grandchildRow = page.getByTestId(`sidebar-thread-child-paseo-${grandchild.id}`);
    const busyRow = page.getByTestId(`sidebar-thread-child-paseo-${busy.id}`);
    await expect(grandchildRow).toBeVisible();
    const childBox = await childRow.boundingBox();
    const grandchildBox = await grandchildRow.boundingBox();
    const busyBox = await busyRow.boundingBox();
    // A row is full width and indents with padding, so compare where its title starts.
    const childLabel = await childRow.getByText("Tree child").boundingBox();
    const grandchildLabel = await grandchildRow.getByText("Tree grandchild").boundingBox();
    const busyLabel = await busyRow.getByText("Tree busy").boundingBox();
    // The grandchild sits right under its spawner, one indent step in; the other child stays flush.
    expect(grandchildBox?.y).toBeGreaterThan(childBox?.y ?? Infinity);
    expect(busyBox?.y).toBeGreaterThan(grandchildBox?.y ?? Infinity);
    expect(grandchildLabel?.x).toBeGreaterThan(childLabel?.x ?? Infinity);
    expect(busyLabel?.x).toBe(childLabel?.x);
    await page.screenshot({ path: testInfo.outputPath("sidebar-thread-tree.png") });

    let confirmMessage = "";
    page.once("dialog", (dialog) => {
      confirmMessage = dialog.message();
      void dialog.dismiss();
    });
    await page.getByTestId(`sidebar-thread-children-kebab-${parentKey}`).tap();
    await page.getByTestId(`sidebar-thread-children-archive-finished-${parentKey}`).tap();
    await expect.poll(() => confirmMessage).toContain("Archive 2 finished subagents?");
    await expect(childRow).toBeVisible();
    await expect(grandchildRow).toBeVisible();

    page.once("dialog", (next) => void next.accept());
    await page.getByTestId(`sidebar-thread-children-kebab-${parentKey}`).tap();
    await page.getByTestId(`sidebar-thread-children-archive-finished-${parentKey}`).tap();
    await expect(childRow).toHaveCount(0);
    await expect(grandchildRow).toHaveCount(0);
    // A running agent is never archived.
    await expect(busyRow).toBeVisible();
    await expect(fold).toHaveAccessibleName("1 subagent");
  } finally {
    await seeded.cleanup();
  }
});
