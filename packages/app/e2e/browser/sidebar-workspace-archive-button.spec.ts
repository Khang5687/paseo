import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import {
  createMockIdleAgent,
  expectSessionRowArchived,
  openSessions,
} from "../support/helpers/archive-tab";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { expectWorkspaceAbsentFromSidebar } from "../support/helpers/sidebar";
import { restoreWorkspaceFromHistory } from "../support/helpers/workspace-recovery";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

function workspaceRow(page: Page, workspace: SeededWorkspace) {
  return page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspace.workspaceId}`);
}

function archiveButton(page: Page, workspace: SeededWorkspace) {
  return page.getByTestId(`sidebar-workspace-archive-${getServerId()}:${workspace.workspaceId}`);
}

test.describe("Sidebar workspace archive button", () => {
  test("archives on one click from the hovered row and restores from History", async ({
    page,
  }, testInfo) => {
    const workspace = await seedWorkspace({ repoPrefix: "sidebar-archive-button-" });
    try {
      const agent = await createMockIdleAgent(workspace.client, {
        cwd: workspace.workspaceDirectory,
        workspaceId: workspace.workspaceId,
        title: `archive-button-${randomUUID().slice(0, 8)}`,
      });
      await gotoAppShell(page);
      await waitForSidebarHydration(page);

      const row = workspaceRow(page, workspace);
      await expect(row).toBeVisible({ timeout: 30_000 });
      await page.mouse.move(0, 0);
      await expect(archiveButton(page, workspace)).toHaveCount(0);

      await row.hover();
      await expect(archiveButton(page, workspace)).toBeVisible({ timeout: 10_000 });
      await testInfo.attach("desktop-hover", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
      await archiveButton(page, workspace).click();

      await expectWorkspaceAbsentFromSidebar(page, workspace.workspaceId);

      await openSessions(page);
      await expectSessionRowArchived(page, agent.title);
      await restoreWorkspaceFromHistory(page, getServerId(), agent.id);
      await expect(workspaceRow(page, workspace)).toBeVisible({ timeout: 30_000 });
    } finally {
      await workspace.cleanup();
    }
  });

  test.describe("compact layout", () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

    test("shows the archive button without hover and archives on tap", async ({
      page,
    }, testInfo) => {
      const workspace = await seedWorkspace({ repoPrefix: "sidebar-archive-button-compact-" });
      try {
        await gotoAppShell(page);
        await page.getByRole("button", { name: "Open menu", exact: true }).tap();
        await waitForSidebarHydration(page);

        await expect(workspaceRow(page, workspace)).toBeVisible({ timeout: 30_000 });
        await expect(archiveButton(page, workspace)).toBeVisible({ timeout: 10_000 });
        await testInfo.attach("compact-sidebar", {
          body: await page.screenshot(),
          contentType: "image/png",
        });
        await archiveButton(page, workspace).tap();

        await expectWorkspaceAbsentFromSidebar(page, workspace.workspaceId);
      } finally {
        await workspace.cleanup();
      }
    });
  });
});
