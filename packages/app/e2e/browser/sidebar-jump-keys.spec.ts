import { expect, type Page } from "@playwright/test";
import { test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";

function workspaceKey(workspaceId: string): string {
  return `${getServerId()}:${workspaceId}`;
}

async function expectWorkspaceOpen(page: Page, workspaceId: string): Promise<void> {
  await expect.poll(() => page.url(), { timeout: 30_000 }).toContain(`/workspace/${workspaceId}`);
}

async function openWorkspaceRow(page: Page, workspaceId: string): Promise<void> {
  await page.getByTestId(`sidebar-workspace-row-${workspaceKey(workspaceId)}`).click();
  await expectWorkspaceOpen(page, workspaceId);
}

async function addWorkspace(project: SeededWorkspace, title: string): Promise<string> {
  const created = await project.client.createWorkspace({
    source: { kind: "directory", path: project.repoPath, projectId: project.projectId },
    title,
  });
  if (!created.workspace) throw new Error(created.error ?? `Failed to seed ${title}`);
  return created.workspace.id;
}

async function startWaitingAgent(project: SeededWorkspace): Promise<void> {
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

test.describe("Jump keys", () => {
  test.use({ viewport: { width: 1000, height: 800 } });

  test("Alt+Tab shows recent workspaces and opens the highlighted one on release", async ({
    page,
  }) => {
    const project = await seedWorkspace({ repoPrefix: "jump-recent-", title: "Alpha work" });
    try {
      const betaId = await addWorkspace(project, "Beta work");
      await gotoAppShell(page);
      await openWorkspaceRow(page, project.workspaceId);
      await openWorkspaceRow(page, betaId);

      await page.keyboard.down("Alt");
      await page.keyboard.press("Tab");
      const overlay = page.getByTestId("recent-workspaces-overlay");
      await expect(overlay).toBeVisible();
      await expect(
        page.getByTestId(`recent-workspaces-row-${workspaceKey(project.workspaceId)}`),
      ).toHaveAttribute("aria-selected", "true");
      await page.screenshot({ path: test.info().outputPath("desktop-recent-walk.png") });
      await page.keyboard.up("Alt");

      await expect(overlay).toHaveCount(0);
      await expectWorkspaceOpen(page, project.workspaceId);
    } finally {
      await project.cleanup();
    }
  });

  test("Alt+J opens the workspace waiting on you in another project", async ({ page }) => {
    const waiting = await seedWorkspace({ repoPrefix: "jump-waiting-", title: "Waiting work" });
    const other = await seedWorkspace({ repoPrefix: "jump-other-", title: "Other work" });
    try {
      await startWaitingAgent(waiting);
      await gotoAppShell(page);
      await openWorkspaceRow(page, other.workspaceId);
      await expect
        .poll(
          async () => {
            await page.keyboard.press("Alt+J");
            return page.url();
          },
          { timeout: 30_000 },
        )
        .toContain(`/workspace/${waiting.workspaceId}`);
    } finally {
      await other.cleanup();
      await waiting.cleanup();
    }
  });

  test.describe("compact", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

    test("the Next waiting button opens the waiting workspace", async ({ page }) => {
      const waiting = await seedWorkspace({ repoPrefix: "jump-phone-", title: "Waiting work" });
      try {
        await startWaitingAgent(waiting);
        await gotoAppShell(page);
        await page.getByRole("button", { name: "Open menu", exact: true }).tap();
        const button = page.getByTestId("sidebar-next-waiting");
        await expect(button).toHaveText("Next waiting · 1", { timeout: 30_000 });
        await page.screenshot({ path: test.info().outputPath("compact-next-waiting.png") });
        await button.tap();
        await expectWorkspaceOpen(page, waiting.workspaceId);
      } finally {
        await waiting.cleanup();
      }
    });
  });
});
