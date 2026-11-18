import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { clickSessionRow, openSessions } from "../support/helpers/archive-tab";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { getE2EDaemonPort } from "../support/helpers/daemon-port";
import { addConnectedHostAndReload, waitForConnectedHost } from "../support/helpers/hosts";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { openSettingsSection } from "../support/helpers/settings";

// A Mac-like host sends copies of the files its agents link to an always-on host. With the Mac
// asleep, a file its chat links still opens on the phone, read from the always-on host's copy,
// and Settings → Files shows that host's copies and limits.
test.use({ hasTouch: true });

interface CopiesClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  addHost(input: { connection: string }): Promise<unknown>;
  listHosts(): Promise<{ hosts: { status: string }[] }>;
  updateFileCopySettings(input: { targetServerId?: string | null }): Promise<unknown>;
  getFileCopySettings(): Promise<{ settings: { keepDays: number } | null }>;
  listFileCopies(): Promise<{ entries: { path: string; sourceServerId: string }[] }>;
}

const PLAN = "notes/plan.md";
const PLAN_TEXT = "Plan kept while the Mac sleeps";

async function copiedPaths(client: CopiesClient): Promise<string[]> {
  const { entries } = await client.listFileCopies();
  return entries.map((entry) => entry.path);
}

test.describe("Files from a sleeping host", () => {
  test.describe.configure({ timeout: 300_000 });

  test("open from another host's copy and show that host's copies in settings", async ({
    page,
  }) => {
    const omenServerId = getServerId();
    const mac = await startIsolatedHostDaemon(
      `srv_mac_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
    );
    const omen = await connectDaemonClient<CopiesClient>({ clientIdPrefix: "copies-omen" });
    const macClient = await connectDaemonClient<CopiesClient>({
      clientIdPrefix: "copies-mac",
      port: mac.port,
    });
    const workspace = await seedWorkspace({ repoPrefix: "offline-host-copy-", port: mac.port });
    try {
      await macClient.addHost({ connection: `127.0.0.1:${getE2EDaemonPort()}` });
      await expect
        .poll(async () => (await macClient.listHosts()).hosts[0]?.status, { timeout: 30_000 })
        .toBe("online");
      await macClient.updateFileCopySettings({ targetServerId: omenServerId });

      const planPath = path.join(workspace.repoPath, PLAN);
      await mkdir(path.dirname(planPath), { recursive: true });
      await writeFile(planPath, `# Plan\n\n${PLAN_TEXT}\n`);
      const agent = await workspace.client.createAgent({
        provider: "mock",
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: "Copies while asleep",
        modeId: "load-test",
        model: "e2e-fast-stream",
        initialPrompt: "Where is the plan?",
        featureValues: { mockAssistantResponse: `The plan is in \`${PLAN}\`.` },
      });
      await expect.poll(() => copiedPaths(omen), { timeout: 60_000 }).toEqual([planPath]);

      // The phone has the chat open; the Mac then goes to sleep.
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
      // A cold deep link to the connected host's workspace redirected to /open-project here,
      // so open the chat from History, as a user would.
      await openSessions(page);
      await clickSessionRow(page, "Copies while asleep");
      const link = page.getByTestId("assistant-message").getByText(PLAN, { exact: true });
      await expect(link).toBeVisible({ timeout: 60_000 });
      await page.setViewportSize({ width: 390, height: 844 });
      await macClient.close();
      await mac.close();

      await link.tap();
      await expect(page.getByText(PLAN_TEXT)).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId("offline-file-bar")).toBeVisible();
      await page.screenshot({ path: test.info().outputPath("opened-from-omen-copy.png") });

      // Settings → Files: the Omen's copies and limits, and the phone's saved copy by host.
      // At phone width the sidebar sits behind the menu button.
      await page.getByRole("button", { name: "Open menu", exact: true }).first().tap();
      await page.locator('[data-testid="sidebar-settings"]:visible').first().tap();
      await openSettingsSection(page, "files");
      const copies = page.getByTestId(`host-copies-${omenServerId}`);
      await expect(copies.getByText("Copies on Omen box")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId(`host-copies-usage-${omenServerId}`)).toContainText("1 files");
      const keepDays = page.getByTestId(`host-copies-keep-days-${omenServerId}`);
      await keepDays.tap();
      await keepDays.fill("7");
      await keepDays.press("Enter");
      await expect.poll(async () => (await omen.getFileCopySettings()).settings?.keepDays).toBe(7);

      const saved = page.getByTestId(`offline-files-host-${mac.serverId}`);
      await expect(saved.getByText("Mac box")).toBeVisible();
      await expect(saved.getByText("plan.md", { exact: true })).toBeVisible();
      await copies.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: test.info().outputPath("settings-files-copies.png"),
        fullPage: true,
      });

      // Long-press removes the phone's copy after a confirm.
      page.once("dialog", (dialog) => void dialog.accept());
      const row = saved.getByTestId("offline-files-row");
      await row.scrollIntoViewIfNeeded();
      const box = await row.boundingBox();
      if (!box) throw new Error("Saved file row has no box");
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(900);
      await page.mouse.up();
      await expect(saved).toHaveCount(0, { timeout: 15_000 });
    } finally {
      await omen.close();
      await macClient.close().catch(() => undefined);
      await workspace.cleanup();
      await mac.close();
    }
  });
});
