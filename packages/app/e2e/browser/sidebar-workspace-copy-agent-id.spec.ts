import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { createMockIdleAgent } from "../support/helpers/archive-tab";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

const SCRATCH_DIR = path.resolve(__dirname, "../../../../.scratch");

function workspaceKey(workspace: SeededWorkspace): string {
  return `${getServerId()}:${workspace.workspaceId}`;
}

async function expectClipboard(page: Page, text: string): Promise<void> {
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(text);
}

async function clearClipboard(page: Page): Promise<void> {
  await page.evaluate(() => navigator.clipboard.writeText(""));
}

async function saveScreenshot(page: Page, name: string): Promise<void> {
  await mkdir(SCRATCH_DIR, { recursive: true });
  await writeFile(path.join(SCRATCH_DIR, `${name}.png`), await page.screenshot());
}

test.describe("Sidebar workspace copy agent ID", () => {
  test("copies the thread's agent id from the hover button and the kebab menu", async ({
    context,
    page,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const workspace = await seedWorkspace({ repoPrefix: "sidebar-copy-agent-id-" });
    try {
      const agent = await createMockIdleAgent(workspace.client, {
        cwd: workspace.workspaceDirectory,
        workspaceId: workspace.workspaceId,
        title: `copy-agent-id-${randomUUID().slice(0, 8)}`,
      });
      await gotoAppShell(page);
      await waitForSidebarHydration(page);

      const key = workspaceKey(workspace);
      const row = page.getByTestId(`sidebar-workspace-row-${key}`);
      const copyButton = page.getByTestId(`sidebar-workspace-copy-agent-id-${key}`);
      await expect(row).toBeVisible({ timeout: 30_000 });
      await page.mouse.move(0, 0);
      await expect(copyButton).toHaveCount(0);

      await row.hover();
      await expect(copyButton).toBeVisible({ timeout: 10_000 });
      await copyButton.hover();
      await expect(page.getByText("Copy agent ID", { exact: true })).toBeVisible();
      await saveScreenshot(page, "copy-agent-id-desktop-hover");

      await copyButton.click();
      await expectClipboard(page, agent.id);
      await expect(page.getByText(`Copied Agent ID ${agent.id.slice(0, 7)}`)).toBeVisible();

      await clearClipboard(page);
      await row.hover();
      await page.getByTestId(`sidebar-workspace-kebab-${key}`).click();
      await page.getByTestId(`sidebar-workspace-menu-copy-agent-id-${key}`).click();
      await expectClipboard(page, agent.id);
    } finally {
      await workspace.cleanup();
    }
  });

  test.describe("compact layout", () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

    test("copies the agent id by tap, from the visible button and from the menu", async ({
      context,
      page,
    }) => {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      const workspace = await seedWorkspace({ repoPrefix: "sidebar-copy-agent-id-compact-" });
      try {
        const agent = await createMockIdleAgent(workspace.client, {
          cwd: workspace.workspaceDirectory,
          workspaceId: workspace.workspaceId,
          title: `copy-agent-id-${randomUUID().slice(0, 8)}`,
        });
        await gotoAppShell(page);
        await page.getByRole("button", { name: "Open menu", exact: true }).tap();
        await waitForSidebarHydration(page);

        const key = workspaceKey(workspace);
        const copyButton = page.getByTestId(`sidebar-workspace-copy-agent-id-${key}`);
        await expect(copyButton).toBeVisible({ timeout: 30_000 });
        await saveScreenshot(page, "copy-agent-id-compact-sidebar");

        await copyButton.tap();
        await expectClipboard(page, agent.id);
        await expect(page.getByText(`Copied Agent ID ${agent.id.slice(0, 7)}`)).toBeVisible();

        await clearClipboard(page);
        await page.getByTestId(`sidebar-workspace-kebab-${key}`).tap();
        const item = page.getByTestId(`sidebar-workspace-menu-copy-agent-id-${key}`);
        await expect(item).toBeVisible();
        await page.waitForTimeout(600);
        await saveScreenshot(page, "copy-agent-id-compact-menu");
        await item.tap();
        await expectClipboard(page, agent.id);
      } finally {
        await workspace.cleanup();
      }
    });
  });
});
