import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator } from "@playwright/test";
import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { createMockIdleAgent } from "../support/helpers/archive-tab";
import { projectEquivalenceViewKey } from "../support/helpers/project-view-key";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { BOTS_PLUGIN_ID, installSidebarPlugins } from "../support/helpers/plugin-sidebar-items";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

const SCRATCH_DIR = path.resolve(__dirname, "../../../../.scratch");
const PHONE = { width: 390, height: 844 };
/** The owner's phone is about 360 wide. */
const NARROW_PHONE = { width: 360, height: 800 };
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
  agentId: string;
}

// One project with a chat, one whose only workspace is archived so it is empty.
async function seedProjects(): Promise<Seeded> {
  const full = await seedWorkspace({ repoPrefix: "phone-icons-full-", title: "Full work" });
  const agent = await createMockIdleAgent(full.client, {
    cwd: full.workspaceDirectory,
    workspaceId: full.workspaceId,
    title: "Phone icons chat",
  });
  const empty = await seedWorkspace({ repoPrefix: "phone-icons-empty-", title: "Empty work" });
  const archived = await empty.client.archiveWorkspace(empty.workspaceId);
  if (archived.error) throw new Error(archived.error);
  return { full, empty, agentId: agent.id };
}

function clipboardReader(page: Page): () => Promise<string> {
  return () => page.evaluate(() => navigator.clipboard.readText());
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
    context,
    page,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
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
      const copyItem = page.getByTestId(`sidebar-workspace-menu-copy-agent-id-${key}`);
      await expect(copyItem).toBeVisible();
      await page.waitForTimeout(600);
      await saveScreenshot(page, "phone-icons-chat-menu");
      await copyItem.tap();
      await expect.poll(clipboardReader(page)).toBe(seeded.agentId);
      await expect(copyItem).toHaveCount(0);
    });

    await test.step("a long press names the button and opens Buttons to show", async () => {
      await longPress(page, iconRow.getByTestId("sidebar-sessions"));
      // The sheet is titled with the button's name and stays open once the finger lifts.
      const openButtons = page.getByTestId("sidebar-nav-buttons-open");
      await expect(openButtons).toBeInViewport({ ratio: 1 });
      await expect(page.getByText("History", { exact: true })).toBeVisible();
      await saveScreenshot(page, "phone-icons-long-press");
      await openButtons.tap();
      const done = page.getByTestId("sidebar-nav-buttons-done");
      const notesItem = page.getByTestId("sidebar-nav-buttons-item-notes");
      await expect(notesItem).toBeVisible();
      await expect(notesItem).toHaveAttribute("aria-checked", "false");
      await page.waitForTimeout(400);
      await saveScreenshot(page, "phone-icons-buttons-sheet");
      await notesItem.tap();
      await expect(notesItem).toHaveAttribute("aria-checked", "true");
      await saveScreenshot(page, "phone-icons-buttons-notes-on");
      await done.tap();
      await expect(done).toHaveCount(0);
      await expect(openButtons).not.toBeInViewport();
      await expect(iconRow.getByTestId("sidebar-notes")).toBeVisible();
      await page.waitForTimeout(400);
      await saveScreenshot(page, "phone-icons-row-with-notes");
    });

    await test.step("a tap does what the row did", async () => {
      await iconRow.getByTestId("sidebar-sessions").tap();
      await expect(page).toHaveURL(/\/sessions/);
      await expect(iconRow).not.toBeInViewport();
    });
  });
});

// Seven buttons and a close button wrapped onto a second line on a 360-wide phone. Each width
// gets the sidebar plugins' six extra header buttons, so some never fit.
for (const viewport of [PHONE, NARROW_PHONE]) {
  test.describe(`Phone sidebar icon row with more buttons than fit at ${viewport.width}`, () => {
    test.use({ viewport, isMobile: true, hasTouch: true });
    let plugins: { cleanup(): Promise<void> };

    test.beforeEach(async () => {
      plugins = await installSidebarPlugins();
    });

    test.afterEach(async () => {
      await plugins.cleanup();
    });

    test("keeps one row and moves the rest into More, which presses them", async ({ page }) => {
      await gotoAppShell(page);
      await page.getByRole("button", { name: "Open menu", exact: true }).tap();
      await waitForSidebarHydration(page);
      const iconRow = page.getByTestId("sidebar-nav-icon-row");
      const more = iconRow.getByTestId("sidebar-nav-more");
      const statusTestId = `plugin-sidebar-${BOTS_PLUGIN_ID}-bots-status`;

      await test.step("one row: New workspace and Search stay, More sits before the X", async () => {
        await expect(more).toBeVisible();
        await expect(iconRow.getByTestId("sidebar-global-new-workspace")).toBeVisible();
        await expect(iconRow.getByTestId("sidebar-search")).toBeVisible();
        await expect(iconRow.getByTestId(statusTestId)).toHaveCount(0);
        const row = await iconRow.boundingBox();
        const moreBox = await more.boundingBox();
        const closeBox = await iconRow.getByTestId("sidebar-close").boundingBox();
        expect(row?.height ?? 0).toBeLessThan(60);
        expect(moreBox?.y).toBe(closeBox?.y);
        expect((moreBox?.x ?? 0) + (moreBox?.width ?? 0)).toBeLessThanOrEqual(closeBox?.x ?? 0);
        await saveScreenshot(page, `phone-icons-row-more-${viewport.width}`);
      });

      await test.step("More lists the buttons that did not fit by name", async () => {
        await more.tap();
        const status = page.getByTestId(`sidebar-nav-more-item-${statusTestId}`);
        await expect(status).toBeInViewport();
        await expect(status).toContainText("Bot status");
        await page.waitForTimeout(400);
        await saveScreenshot(page, `phone-icons-more-sheet-${viewport.width}`);
        await status.tap();
        await expect(page.getByText("Bot status details", { exact: true })).toBeVisible();
      });
    });
  });
}

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
