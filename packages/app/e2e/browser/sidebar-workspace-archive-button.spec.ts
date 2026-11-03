import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Dialog } from "@playwright/test";
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

const SCRATCH_DIR = path.resolve(__dirname, "../../../../.scratch");

async function saveScreenshot(page: Page, name: string): Promise<void> {
  await mkdir(SCRATCH_DIR, { recursive: true });
  await writeFile(path.join(SCRATCH_DIR, `${name}.png`), await page.screenshot());
}

// The confirmation is a synchronous web `window.confirm()`: the click that opens it does not
// resolve until the dialog is answered, so the answer is registered before the click.
async function answerNextDialog(page: Page, answer: "accept" | "dismiss"): Promise<() => Dialog> {
  let seen: Dialog | undefined;
  page.once("dialog", (dialog) => {
    seen = dialog;
    void (answer === "accept" ? dialog.accept() : dialog.dismiss());
  });
  return () => {
    if (!seen) throw new Error("Expected an archive confirmation dialog, but none was shown.");
    return seen;
  };
}

function workspaceRow(page: Page, workspace: SeededWorkspace) {
  return page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspace.workspaceId}`);
}

function archiveButton(page: Page, workspace: SeededWorkspace) {
  return page.getByTestId(`sidebar-workspace-archive-${getServerId()}:${workspace.workspaceId}`);
}

test.describe("Sidebar workspace archive button", () => {
  test("asks before archiving from the hovered row, then restores from History", async ({
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

      const cancelled = await answerNextDialog(page, "dismiss");
      await archiveButton(page, workspace).click();
      expect(cancelled().type()).toBe("confirm");
      expect(cancelled().message()).toContain("Archive workspace");
      expect(cancelled().message()).toContain("You can restore it from History.");
      await expect(row).toBeVisible();

      await row.hover();
      await answerNextDialog(page, "accept");
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

    test("hides the archive icon and archives from the kebab menu after confirming", async ({
      page,
    }, testInfo) => {
      const workspace = await seedWorkspace({ repoPrefix: "sidebar-archive-button-compact-" });
      try {
        await gotoAppShell(page);
        await page.getByRole("button", { name: "Open menu", exact: true }).tap();
        await waitForSidebarHydration(page);

        await expect(workspaceRow(page, workspace)).toBeVisible({ timeout: 30_000 });
        const key = `${getServerId()}:${workspace.workspaceId}`;
        const kebab = page.getByTestId(`sidebar-workspace-kebab-${key}`);
        await expect(kebab).toBeVisible({ timeout: 10_000 });
        await expect(archiveButton(page, workspace)).toHaveCount(0);
        await saveScreenshot(page, "archive-confirm-compact-sidebar");
        await testInfo.attach("compact-sidebar", {
          body: await page.screenshot(),
          contentType: "image/png",
        });

        await kebab.tap();
        const item = page.getByTestId(`sidebar-workspace-menu-archive-${key}`);
        await expect(item).toBeVisible();
        await page.waitForTimeout(600);
        await saveScreenshot(page, "archive-confirm-compact-menu");
        const cancelled = await answerNextDialog(page, "dismiss");
        await item.tap();
        expect(cancelled().message()).toContain("You can restore it from History.");
        await expect(workspaceRow(page, workspace)).toBeVisible();

        await kebab.tap();
        await answerNextDialog(page, "accept");
        await page.getByTestId(`sidebar-workspace-menu-archive-${key}`).tap();

        await expectWorkspaceAbsentFromSidebar(page, workspace.workspaceId);
      } finally {
        await workspace.cleanup();
      }
    });
  });
});
