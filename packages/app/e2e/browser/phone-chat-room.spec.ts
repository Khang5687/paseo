import { expect, test, type Page } from "../support/fixtures";
import {
  attachFileFromMenu,
  composerLocator,
  expectComposerVisible,
} from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { seedRunningSubagent } from "../support/helpers/subagents";

const PHONE = { width: 390, height: 844 };
const TURNS = 4;

function textFile(index: number) {
  return {
    name: `note-${index}.txt`,
    mimeType: "text/plain",
    buffer: Buffer.from(`note ${index}\n`),
  };
}

async function scrollChatToTop(page: Page): Promise<void> {
  const scroll = page.locator('[data-testid="agent-chat-scroll"]:visible').first();
  await scroll.hover();
  await page.mouse.wheel(0, -20_000);
  await scroll.evaluate((element) => {
    if (!(element instanceof HTMLElement)) throw new Error("Chat scroll is not an HTMLElement");
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
}

async function bottomOf(page: Page, testId: string): Promise<number> {
  const box = await page.getByTestId(testId).first().boundingBox();
  if (!box) throw new Error(`${testId} has no box`);
  return box.y + box.height;
}

test("on a phone the composer leaves the chat its room", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize(PHONE);
  const shot = async (name: string) => {
    const path = testInfo.outputPath(`${name}.png`);
    await page.screenshot({ path });
    await testInfo.attach(name, { path, contentType: "image/png" });
  };
  const workspace = await seedMockAgentWorkspace({
    repoPrefix: "phone-chat-room-",
    title: "Phone chat room",
  });
  try {
    for (let turn = 0; turn < TURNS; turn += 1) {
      await workspace.client.sendAgentMessage(workspace.agentId, `phone turn ${turn}`);
      await workspace.client.waitForFinish(workspace.agentId, 15_000);
    }
    await seedRunningSubagent(
      { client: workspace.client, repoPath: workspace.cwd, workspaceId: workspace.workspaceId },
      { parentId: workspace.agentId, title: "Phone child" },
    );
    // A cleared draft leaves a snapshot, which is what "Restore draft" offers back.
    const typed = await workspace.client.setAgentDraft({
      agentId: workspace.agentId,
      text: "a draft long enough to keep in the history",
      attachments: [],
      updatedAt: Date.now(),
      baseRevision: null,
    });
    await workspace.client.setAgentDraft({
      agentId: workspace.agentId,
      text: "",
      attachments: [],
      updatedAt: Date.now() + 1,
      baseRevision: typed.state?.draft?.revision ?? null,
    });

    await openAgentRoute(page, { workspaceId: workspace.workspaceId, agentId: workspace.agentId });
    await expectComposerVisible(page);
    const line = page.getByTestId("composer-status-line");

    await test.step("the tracks and Restore draft share one line on the composer's edge", async () => {
      await expect(line).toContainText("Waiting on 1 subagent", { timeout: 15_000 });
      await expect(line.getByTestId("draft-history-trigger")).toBeVisible({ timeout: 15_000 });
      // Nothing floats over the transcript: the one track bar is the line's.
      await expect(page.getByTestId("composer-track-scroll")).toHaveCount(1);
      await expect(line.getByTestId("composer-track-scroll")).toHaveCount(1);
      const lineBox = await line.boundingBox();
      const inputBox = await composerLocator(page).boundingBox();
      expect(lineBox && inputBox).toBeTruthy();
      expect(lineBox!.height).toBeLessThanOrEqual(32);
      expect(lineBox!.y + lineBox!.height).toBeLessThanOrEqual(inputBox!.y);
      expect(await bottomOf(page, "agent-chat-scroll")).toBeLessThanOrEqual(lineBox!.y + 1);
      await shot("status-line");
    });

    const tray = page.getByTestId("composer-attachment-tray");
    const chip = page.getByTestId("composer-attachment-tray-chip");
    const pills = tray.getByTestId("composer-file-attachment-pill");

    await test.step("up to four files are one row of tiles, each with its own remove", async () => {
      for (let index = 1; index <= 4; index += 1) {
        await attachFileFromMenu(page, textFile(index));
        await expect(pills).toHaveCount(index, { timeout: 10_000 });
      }
      await expect(chip).toHaveCount(0);
      const boxes = await Promise.all((await pills.all()).map((pill) => pill.boundingBox()));
      const tops = new Set(boxes.map((box) => Math.round(box!.y)));
      expect(tops.size).toBe(1);
      for (const box of boxes) expect(box!.height).toBeLessThanOrEqual(48);
      await expect(tray.getByRole("button", { name: "Remove file attachment" })).toHaveCount(4);
      await shot("tiles");
    });

    await test.step("a fifth file folds them into one chip that lists each file", async () => {
      await attachFileFromMenu(page, textFile(5));
      await expect(chip).toContainText("5 files", { timeout: 10_000 });
      await expect(pills).toHaveCount(0);
      await chip.click();
      const panel = page.getByTestId("composer-attachment-tray-panel");
      await expect(panel.getByTestId("composer-file-attachment-pill")).toHaveCount(5);
      await shot("chip-panel");
      await panel.getByRole("button", { name: "Remove file attachment" }).first().click();
      await expect(chip).toHaveCount(0);
      await expect(pills).toHaveCount(4);
    });

    await test.step("jump to latest is a corner arrow that counts new replies", async () => {
      const arrow = page.getByTestId("scroll-to-bottom-button");
      await scrollChatToTop(page);
      await expect(arrow).toBeVisible({ timeout: 10_000 });
      const arrowBox = await arrow.boundingBox();
      expect(arrowBox!.x).toBeGreaterThan(PHONE.width / 2);
      expect(arrowBox!.width).toBeLessThanOrEqual(44);
      await expect(page.getByTestId("scroll-to-bottom-count")).toHaveCount(0);

      await workspace.client.sendAgentMessage(workspace.agentId, "phone turn while reading");
      await workspace.client.waitForFinish(workspace.agentId, 15_000);
      await expect(page.getByTestId("scroll-to-bottom-count")).toHaveText("1", { timeout: 10_000 });
      await expect(arrow).toHaveAccessibleName("Scroll to bottom, 1 new");
      await shot("jump-arrow");

      await arrow.click();
      await expect(arrow).toHaveCount(0, { timeout: 10_000 });
    });
  } finally {
    await workspace.cleanup();
  }
});
