import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import {
  expectMobileAgentSidebarVisible,
  openMobileAgentSidebar,
} from "../support/helpers/sidebar";
import {
  expectManagedSubagentArchived,
  seedParentWithSubagent,
} from "../support/helpers/subagents";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

const SCRATCH_DIR = path.resolve(__dirname, "../../../../.scratch");

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test("a subagent row archives from its kebab menu after confirming", async ({ page }) => {
  const seeded = await seedWorkspace({ repoPrefix: "sidebar-thread-child-archive-" });
  try {
    const pair = await seedParentWithSubagent(seeded, {
      parentTitle: "Orchestrator",
      childTitle: "Local helper",
    });
    const parentKey = `${getServerId()}:${pair.workspaceId}`;

    await gotoAppShell(page);
    await openMobileAgentSidebar(page);
    await expectMobileAgentSidebarVisible(page);
    await waitForSidebarHydration(page);

    await page.getByTestId(`sidebar-thread-children-toggle-${parentKey}`).tap({ timeout: 30_000 });
    const childRow = page.getByTestId(`sidebar-thread-child-paseo-${pair.child.id}`);
    await expect(childRow).toBeVisible();
    await expect(
      page.getByTestId(`sidebar-thread-child-copy-agent-id-${pair.child.id}`),
    ).toBeVisible();

    await page.getByTestId(`sidebar-thread-child-kebab-${pair.child.id}`).tap();
    const item = page.getByTestId(`sidebar-thread-child-menu-archive-${pair.child.id}`);
    await expect(item).toBeVisible();
    await page.waitForTimeout(600);
    await mkdir(SCRATCH_DIR, { recursive: true });
    await writeFile(
      path.join(SCRATCH_DIR, "archive-confirm-child-menu.png"),
      await page.screenshot(),
    );

    let message = "";
    page.once("dialog", (dialog) => {
      message = dialog.message();
      void dialog.dismiss();
    });
    await item.tap();
    expect(message).toContain("Archive subagent?");
    await expect(childRow).toBeVisible();

    await page.getByTestId(`sidebar-thread-child-kebab-${pair.child.id}`).tap();
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByTestId(`sidebar-thread-child-menu-archive-${pair.child.id}`).tap();
    await expectManagedSubagentArchived(seeded, pair.child.id);
    await expect(childRow).toHaveCount(0);
  } finally {
    await seeded.cleanup();
  }
});
