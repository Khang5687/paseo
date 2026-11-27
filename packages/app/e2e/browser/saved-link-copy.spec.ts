import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

// A chat link to a file this device saved after the message was written opens the saved copy,
// not the host's file and not a new download. The host file changes after the save, so the
// text on screen tells the two apart.
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

const FILE = "out/build-report.txt";

async function writeReport(cwd: string, text: string): Promise<void> {
  await mkdir(path.join(cwd, "out"), { recursive: true });
  await writeFile(path.join(cwd, FILE), `${text}\n`, "utf8");
}

function replyLink(page: Page) {
  return page.getByTestId("assistant-message").getByText(FILE, { exact: true });
}

async function saveLinkOffline(page: Page) {
  const link = replyLink(page);
  await expect(link).toBeVisible({ timeout: 30_000 });
  // Mobile Chrome turns a long press on a link into a `contextmenu` event at the finger.
  await link.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    element.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        button: 2,
      }),
    );
  });
  await page.getByTestId("file-link-save-offline").tap();
  await expect(page.getByText("Saved for offline use")).toBeVisible({ timeout: 30_000 });
}

test("a link to a file saved after the message opens the saved copy", async ({ page }) => {
  const workspace = await seedMockAgentWorkspace({
    repoPrefix: "saved-link-copy-",
    title: "Saved link copy",
    initialPrompt: "Where is the report?",
    featureValues: { mockAssistantResponse: `The report is in \`${FILE}\`.` },
  });
  try {
    await writeReport(workspace.cwd, "Build report, saved copy");
    await workspace.client.waitForFinish(workspace.agentId, 30_000);
    await openAgentRoute(page, workspace);
    await saveLinkOffline(page);

    // The host file moves on; the tap must still show what this device saved.
    await writeReport(workspace.cwd, "Build report, newer on the host");
    await replyLink(page).tap();

    const screen = page.getByTestId("saved-file-screen");
    await expect(screen).toBeVisible({ timeout: 15_000 });
    await expect(screen.getByTestId("offline-file-bar")).toBeVisible();
    await expect(screen.getByText("Build report, saved copy")).toBeVisible({ timeout: 15_000 });
    await expect(screen.getByText("Build report, newer on the host")).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("saved-link-copy-phone.png") });
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(screen.getByText("Build report, saved copy")).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("saved-link-copy-desktop.png") });
  } finally {
    await workspace.cleanup();
  }
});
