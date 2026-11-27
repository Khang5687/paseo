import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { clickSessionRow, openSessions } from "../support/helpers/archive-tab";
import { addConnectedHostAndReload, waitForConnectedHost } from "../support/helpers/hosts";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import { seedWorkspace } from "../support/helpers/seed-client";

// A file opened once on the phone lands in "Saved on this device" without asking. With its host
// asleep and the browser offline, the sidebar row lists it and it opens from the saved copy.
test.use({ hasTouch: true });

const PLAN = "notes/plan.md";
const PLAN_TEXT = "Plan the phone keeps";

test.describe("Saved on this device", () => {
  test.describe.configure({ timeout: 300_000 });

  test("keeps an opened file and opens it with the host asleep and no network", async ({
    page,
  }) => {
    const mac = await startIsolatedHostDaemon(
      `srv_mac_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
    );
    const workspace = await seedWorkspace({ repoPrefix: "saved-library-", port: mac.port });
    try {
      const planPath = path.join(workspace.repoPath, PLAN);
      await mkdir(path.dirname(planPath), { recursive: true });
      await writeFile(planPath, `# Plan\n\n${PLAN_TEXT}\n`);
      await workspace.client.createAgent({
        provider: "mock",
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: "Saved library",
        modeId: "load-test",
        model: "e2e-fast-stream",
        initialPrompt: "Where is the plan?",
        featureValues: { mockAssistantResponse: `The plan is in \`${PLAN}\`.` },
      });

      await page.goto("/");
      await addConnectedHostAndReload(page, {
        serverId: mac.serverId,
        label: "Mac box",
        port: mac.port,
        primaryLabel: "Omen box",
      });
      await waitForConnectedHost(page, {
        serverId: mac.serverId,
        endpoint: `localhost:${mac.port}`,
      });
      await openSessions(page);
      await clickSessionRow(page, "Saved library");
      await page.setViewportSize({ width: 390, height: 844 });
      const link = page.getByTestId("assistant-message").getByText(PLAN, { exact: true });
      await expect(link).toBeVisible({ timeout: 60_000 });

      // Opening the file live is all it takes: no Save offline, no prompt.
      await link.tap();
      await expect(page.getByText(PLAN_TEXT)).toBeVisible({ timeout: 60_000 });
      await page.getByRole("button", { name: "Close", exact: true }).last().tap();

      // The Mac goes to sleep and the phone loses signal.
      await mac.close();
      await page.context().setOffline(true);

      await page.getByRole("button", { name: "Open menu", exact: true }).first().tap();
      const row = page.locator('[data-testid="sidebar-saved"]:visible').first();
      await expect(row).toContainText("Saved on this device");
      await expect(page.locator('[data-testid="sidebar-saved-count"]:visible')).toHaveText("1");
      // Screenshots wait for the drawer to finish sliding.
      await expect(row).toBeInViewport({ ratio: 1 });
      await page.screenshot({ path: test.info().outputPath("sidebar-saved-row.png") });

      await row.tap();
      const library = page.getByTestId("saved-library");
      const savedRow = library.getByTestId("offline-files-row").filter({ hasText: "plan.md" });
      // The row names the device the file came from; the folder stays on the file's own page.
      await expect(savedRow).toContainText("Mac box", { timeout: 15_000 });
      await expect(row).not.toBeInViewport();
      await page.screenshot({ path: test.info().outputPath("saved-library-list.png") });

      await savedRow.tap();
      const viewer = page.getByTestId("saved-file-screen");
      await expect(viewer.getByText(PLAN_TEXT)).toBeVisible({ timeout: 30_000 });
      await expect(viewer.getByTestId("offline-file-bar")).toBeVisible();
      await page.screenshot({ path: test.info().outputPath("saved-file-offline.png") });
    } finally {
      await page.context().setOffline(false);
      await workspace.cleanup();
      await mac.close();
    }
  });
});
