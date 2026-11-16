import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import { addConnectedHostAndReload, waitForConnectedHost } from "../support/helpers/hosts";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

// A chat on one host names a file that lives on another host. Tapping it opens the file from the
// host that has it; when several hosts have it, an "Open from" chooser asks which one.
// Each daemon gets its own home folder, so a `~/` path means a different file on each host.
const primaryHome = mkdtempSync(path.join(tmpdir(), "paseo-any-host-primary-"));
test.use({
  e2eDaemonEnvironment: { HOME: primaryHome, USERPROFILE: primaryHome },
  hasTouch: true,
});

const ONLY_SECONDARY = "~/notes/plan.md";
const ON_BOTH = "~/notes/shared.md";
const REPLY = `The plan is in \`${ONLY_SECONDARY}\` and the shared notes are in \`${ON_BOTH}\`.`;

async function writeHomeFile(home: string, file: string, content: string): Promise<void> {
  const absolute = path.join(home, file.slice(2));
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}

function replyLink(page: Page, file: string) {
  return page.getByTestId("assistant-message").getByText(file, { exact: true });
}

test.describe("Files named in a chat open from any host", () => {
  test.describe.configure({ timeout: 300_000 });

  test("opens a file from the host that has it, and asks when several do", async ({ page }) => {
    const secondaryHome = mkdtempSync(path.join(tmpdir(), "paseo-any-host-secondary-"));
    const secondaryServerId = `srv_anyhost_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const secondary = await startIsolatedHostDaemon(secondaryServerId, {
      environment: { HOME: secondaryHome, USERPROFILE: secondaryHome },
    });
    const session = await seedMockAgentWorkspace({
      repoPrefix: "assistant-file-link-any-host-",
      title: "Files on any host",
      initialPrompt: "Where are the notes?",
      featureValues: { mockAssistantResponse: REPLY },
    });
    try {
      await writeHomeFile(secondaryHome, ONLY_SECONDARY, "Plan kept on the secondary host\n");
      await writeHomeFile(secondaryHome, ON_BOTH, "Shared notes from the secondary host\n");
      await writeHomeFile(primaryHome, ON_BOTH, "Shared notes from the primary host\n");
      await session.client.waitForFinish(session.agentId, 30_000);

      await openAgentRoute(page, session);
      await addConnectedHostAndReload(page, {
        serverId: secondary.serverId,
        label: "Secondary box",
        port: secondary.port,
        primaryLabel: "Primary box",
      });
      await waitForConnectedHost(page, {
        serverId: secondary.serverId,
        endpoint: `127.0.0.1:${secondary.port}`,
      });

      // Only the secondary host has it: it opens from there without asking.
      await replyLink(page, ONLY_SECONDARY).click();
      await expect(page.getByTestId("host-chooser")).toHaveCount(0);
      await expect(
        page.getByTestId(`workspace-tab-file@${secondary.serverId}:${ONLY_SECONDARY}`).first(),
      ).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText("Plan kept on the secondary host")).toBeVisible({
        timeout: 30_000,
      });

      // Both hosts have it: on a phone, the chooser lists the chat's host first; the tap picks.
      await page.getByTestId(`workspace-tab-agent_${session.agentId}`).first().click();
      await page.setViewportSize({ width: 390, height: 844 });
      await replyLink(page, ON_BOTH).tap();
      const chooser = page.getByTestId("host-chooser");
      await expect(chooser.getByText("Open from", { exact: true })).toBeVisible({
        timeout: 30_000,
      });
      const rows = chooser.getByTestId(/^host-chooser-row-/);
      await expect(rows).toHaveCount(2);
      await expect(rows.first()).toContainText("Primary box");
      await page.screenshot({ path: test.info().outputPath("open-from-chooser.png") });
      await chooser.getByTestId(`host-chooser-row-${secondary.serverId}`).tap();
      await expect(page.getByText("Shared notes from the secondary host")).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByText("Shared notes from the primary host")).toHaveCount(0);
      await page.screenshot({ path: test.info().outputPath("opened-from-secondary.png") });
    } finally {
      await session.cleanup();
      await secondary.close();
      await rm(secondaryHome, { recursive: true, force: true });
    }
  });
});
