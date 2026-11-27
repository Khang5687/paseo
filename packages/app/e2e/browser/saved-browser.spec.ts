import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator } from "@playwright/test";
import { expect, test, type Page } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

// The Saved screen on a phone: type chips, the sort menu with its Group by choice, folding project
// sections, and select mode with Unpin and Delete plus Undo.
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

const FILES: Record<string, number> = {
  "out/app.apk": 300_000,
  "shots/home.png": 100_000,
  "docs/plan.md": 1_000,
  "src/app.ts": 2_000,
};

async function longPress(page: Page, target: Locator) {
  const box = await target.boundingBox();
  if (!box) throw new Error("No box to press");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(900);
  await page.mouse.up();
}

async function saveLinkOffline(page: Page, file: string) {
  const link = page.getByTestId("assistant-message").getByText(file, { exact: true });
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
  await expect(page.getByText("Saved for offline use").last()).toBeVisible({ timeout: 30_000 });
  // The next long-press opens a new sheet; this one must finish closing first.
  await expect(page.getByTestId("file-link-save-offline")).toHaveCount(0);
}

async function pickFromSortMenu(page: Page, testID: string) {
  await page.getByTestId("saved-sort").tap();
  await page.getByTestId(testID).tap();
  await expect(page.getByTestId("saved-sort-menu")).toBeHidden();
}

test("the Saved screen filters, sorts, groups and acts on many files", async ({ page }) => {
  test.setTimeout(240_000);
  const names = Object.keys(FILES);
  const workspace = await seedMockAgentWorkspace({
    repoPrefix: "saved-browser-",
    title: "Saved browser",
    initialPrompt: "What did you make?",
    featureValues: {
      mockAssistantResponse: `Made ${names.map((name) => `\`${name}\``).join(", ")}.`,
    },
  });
  try {
    for (const [name, size] of Object.entries(FILES)) {
      const target = path.join(workspace.cwd, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, "x".repeat(size));
    }
    await workspace.client.waitForFinish(workspace.agentId, 30_000);
    await openAgentRoute(page, workspace);
    for (const name of names) await saveLinkOffline(page, name);

    await page.getByRole("button", { name: "Open menu", exact: true }).first().tap();
    const sidebarRow = page.locator('[data-testid="sidebar-saved"]:visible').first();
    await sidebarRow.tap();
    const library = page.getByTestId("saved-library");
    const rows = library.getByTestId("offline-files-row");
    await expect(rows).toHaveCount(4, { timeout: 15_000 });
    await expect(library.getByTestId("saved-section-day:today")).toContainText("Today");
    // Screenshots wait for the drawer to finish sliding away.
    await expect(sidebarRow).not.toBeInViewport();
    await expect.poll(async () => (await library.boundingBox())?.x).toBe(0);
    await page.screenshot({ path: test.info().outputPath("saved-browser-phone.png") });

    // A type chip keeps only its kind of file.
    await library.getByTestId("saved-chip-apps").tap();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("app.apk");
    await library.getByTestId("saved-chip-code").tap();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("app.ts");
    await library.getByTestId("saved-chip-all").tap();
    await expect(rows).toHaveCount(4);

    // Biggest first drops the day headings; Group by Project folds by project.
    await pickFromSortMenu(page, "saved-sort-biggest");
    await expect(library.getByTestId("saved-sort")).toContainText("Biggest");
    await expect(rows.first()).toContainText("app.apk");
    await expect(rows.last()).toContainText("plan.md");
    await pickFromSortMenu(page, "saved-group-project");
    const header = library.getByTestId("saved-project-header");
    await expect(header).toHaveCount(1);
    await expect(header).toContainText("4 files");
    await page.screenshot({ path: test.info().outputPath("saved-browser-by-project.png") });
    await header.tap();
    await expect(rows).toHaveCount(0);
    await header.tap();
    await expect(rows).toHaveCount(4);

    // Long-press starts select mode; taps add rows.
    await longPress(page, rows.nth(0));
    const bar = page.getByTestId("saved-selection-bar");
    await expect(bar).toContainText("1 selected");
    await rows.nth(1).tap();
    await expect(bar).toContainText("2 selected");
    await page.screenshot({ path: test.info().outputPath("saved-browser-select.png") });

    // Saved on purpose, so pinned: the bar offers Unpin.
    await expect(library.getByTestId("offline-files-row-pinned")).toHaveCount(4);
    await expect(bar.getByTestId("saved-selection-pin")).toContainText("Unpin");
    await bar.getByTestId("saved-selection-pin").tap();
    await expect(bar).toBeHidden();
    await expect(library.getByTestId("offline-files-row-pinned")).toHaveCount(2);

    // Delete hides at once; Undo brings the files back.
    await longPress(page, rows.nth(0));
    await bar.getByTestId("saved-selection-delete").tap();
    await expect(rows).toHaveCount(3);
    await page.getByTestId("saved-deleted-undo").tap();
    await expect(rows).toHaveCount(4);

    // Without Undo the files go for good once the toast leaves.
    await longPress(page, rows.nth(0));
    await bar.getByTestId("saved-selection-delete").tap();
    await expect(page.getByTestId("saved-deleted-toast")).toBeVisible();
    await expect(page.getByTestId("saved-deleted-toast")).toBeHidden({ timeout: 15_000 });
    await expect(rows).toHaveCount(3);
    await page.reload();
    await expect(page.getByTestId("saved-library").getByTestId("offline-files-row")).toHaveCount(
      3,
      {
        timeout: 30_000,
      },
    );

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.screenshot({ path: test.info().outputPath("saved-browser-desktop.png") });
  } finally {
    await workspace.cleanup();
  }
});
