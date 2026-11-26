import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator } from "@playwright/test";
import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { createMockIdleAgent } from "../support/helpers/archive-tab";
import { projectEquivalenceViewKey } from "../support/helpers/project-view-key";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

const SCRATCH_DIR = path.resolve(__dirname, "../../../../.scratch");
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };
const BUILTIN_BUTTONS = [
  "sidebar-global-new-workspace",
  "sidebar-sessions",
  "sidebar-search",
  "sidebar-schedules",
];

async function saveScreenshot(page: Page, name: string): Promise<void> {
  await mkdir(SCRATCH_DIR, { recursive: true });
  await writeFile(path.join(SCRATCH_DIR, `${name}.png`), await page.screenshot());
}

/** A held touch, as a finger does it: touch start, wait, touch end. */
async function longPress(page: Page, target: Locator): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error("long-press target must be laid out");
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
  await page.waitForTimeout(900);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

interface Seeded {
  full: SeededWorkspace;
  empty: SeededWorkspace;
}

// One project with a chat, one whose only workspace is archived so it is empty.
async function seedProjects(): Promise<Seeded> {
  const full = await seedWorkspace({ repoPrefix: "phone-icons-full-", title: "Full work" });
  await createMockIdleAgent(full.client, {
    cwd: full.workspaceDirectory,
    workspaceId: full.workspaceId,
    title: "Phone icons chat",
  });
  const empty = await seedWorkspace({ repoPrefix: "phone-icons-empty-", title: "Empty work" });
  const archived = await empty.client.archiveWorkspace(empty.workspaceId);
  if (archived.error) throw new Error(archived.error);
  return { full, empty };
}

function ghostRow(page: Page, project: SeededWorkspace): Locator {
  return page.getByTestId(
    `sidebar-project-new-workspace-row-${projectEquivalenceViewKey(project.projectKey)}`,
  );
}

function projectRow(page: Page, project: SeededWorkspace): Locator {
  return page.getByTestId(`sidebar-project-row-${projectEquivalenceViewKey(project.projectKey)}`);
}

let seeded: Seeded;

test.beforeEach(async () => {
  seeded = await seedProjects();
});

test.afterEach(async () => {
  await seeded.full.cleanup();
  await seeded.empty.cleanup();
});

test.describe("Phone sidebar icon row at phone width", () => {
  test.use({ viewport: PHONE, isMobile: true, hasTouch: true });

  test("shows icon buttons, names one on long press, and lets the user show Notes again", async ({
    page,
  }) => {
    await gotoAppShell(page);
    await page.getByRole("button", { name: "Open menu", exact: true }).tap();
    await waitForSidebarHydration(page);
    const iconRow = page.getByTestId("sidebar-nav-icon-row");

    await test.step("the top items are one row of icons with the close button", async () => {
      await expect(iconRow).toBeVisible();
      for (const testId of BUILTIN_BUTTONS) {
        await expect(iconRow.getByTestId(testId)).toBeVisible();
      }
      await expect(iconRow.getByTestId("sidebar-close")).toBeVisible();
      await expect(iconRow.getByTestId("sidebar-notes")).toHaveCount(0);
      const rowBox = await iconRow.boundingBox();
      expect(rowBox?.height ?? 0).toBeLessThan(60);
      await saveScreenshot(page, "phone-icons-row");
    });

    await test.step("an empty project has no ghost row and chats have no copy icon", async () => {
      await expect(projectRow(page, seeded.empty)).toBeVisible({ timeout: 30_000 });
      await expect(ghostRow(page, seeded.empty)).toHaveCount(0);
      const key = `${getServerId()}:${seeded.full.workspaceId}`;
      await expect(page.getByTestId(`sidebar-workspace-row-${key}`)).toBeVisible();
      await expect(page.getByTestId(`sidebar-workspace-copy-agent-id-${key}`)).toHaveCount(0);
      await page.getByTestId(`sidebar-workspace-kebab-${key}`).tap();
      await expect(page.getByTestId(`sidebar-workspace-menu-copy-agent-id-${key}`)).toBeVisible();
      await page.waitForTimeout(600);
      await saveScreenshot(page, "phone-icons-chat-menu");
      await page.keyboard.press("Escape");
      await expect(page.getByTestId(`sidebar-workspace-menu-copy-agent-id-${key}`)).toHaveCount(0);
    });

    await test.step("a long press names the button and opens Buttons to show", async () => {
      await longPress(page, iconRow.getByTestId("sidebar-sessions"));
      const menu = page.getByTestId("sidebar-sessions-menu");
      await expect(menu).toBeVisible();
      await expect(menu.getByText("History", { exact: true })).toBeVisible();
      await page.waitForTimeout(600);
      await saveScreenshot(page, "phone-icons-long-press");
      await page.getByTestId("sidebar-nav-buttons-open").tap();
      const notesItem = page.getByTestId("sidebar-nav-buttons-item-notes");
      await expect(notesItem).toBeVisible();
      await expect(notesItem).toHaveAttribute("aria-checked", "false");
      await page.waitForTimeout(400);
      await saveScreenshot(page, "phone-icons-buttons-sheet");
      await notesItem.tap();
      await expect(notesItem).toHaveAttribute("aria-checked", "true");
      await saveScreenshot(page, "phone-icons-buttons-notes-on");
      await page.getByTestId("sidebar-nav-buttons-done").tap();
      await expect(menu).toHaveCount(0);
      await expect(iconRow.getByTestId("sidebar-notes")).toBeVisible();
      await saveScreenshot(page, "phone-icons-row-with-notes");
    });

    await test.step("a tap does what the row did", async () => {
      await iconRow.getByTestId("sidebar-sessions").tap();
      await expect(page).toHaveURL(/\/sessions/);
      await expect(iconRow).not.toBeInViewport();
    });
  });
});

test.describe("Phone sidebar icon row at desktop width", () => {
  test.use({ viewport: DESKTOP });

  test("keeps the full rows, the ghost row and Notes", async ({ page }) => {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await expect(page.getByTestId("sidebar-nav-icon-row")).toHaveCount(0);
    for (const testId of [...BUILTIN_BUTTONS, "sidebar-notes"]) {
      await expect(page.getByTestId(testId)).toBeVisible();
    }
    await expect(page.getByTestId("sidebar-global-new-workspace")).toContainText("New workspace");
    await expect(projectRow(page, seeded.empty)).toBeVisible({ timeout: 30_000 });
    await expect(ghostRow(page, seeded.empty)).toBeVisible();
    await saveScreenshot(page, "phone-icons-desktop");
  });
});
