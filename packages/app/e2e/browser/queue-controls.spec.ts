import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import {
  attachImageFromMenu,
  composerLocator,
  configureComposerQueueSend,
  expectComposerDraft,
  startRunningMockAgent,
  type MockAgentSetup,
} from "../support/helpers/composer";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";

const QUEUE_IMAGE = {
  name: "queued.png",
  mimeType: "image/png",
  buffer: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  ),
};

interface QueueSummary {
  id: string;
  text: string;
  imageCount: number;
}

/** A client of its own, separate from the browser and the seeding client. */
interface QueueObserverClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  fetchAgent(options: { agentId: string }): Promise<{
    agent: { queuedMessages?: QueueSummary[]; queuePaused?: boolean };
  } | null>;
}

async function daemonQueue(
  observer: QueueObserverClient,
  agentId: string,
): Promise<{ texts: string[]; paused: boolean; entries: QueueSummary[] }> {
  const result = await observer.fetchAgent({ agentId });
  const entries = result?.agent.queuedMessages ?? [];
  return {
    texts: entries.map((entry) => entry.text),
    paused: result?.agent.queuePaused === true,
    entries,
  };
}

async function expectDaemonQueue(
  observer: QueueObserverClient,
  agentId: string,
  texts: string[],
): Promise<QueueSummary[]> {
  await expect
    .poll(async () => (await daemonQueue(observer, agentId)).texts, { timeout: 10_000 })
    .toEqual(texts);
  return (await daemonQueue(observer, agentId)).entries;
}

async function expectDaemonQueuePaused(
  observer: QueueObserverClient,
  agentId: string,
  paused: boolean,
): Promise<void> {
  await expect.poll(async () => (await daemonQueue(observer, agentId)).paused).toBe(paused);
}

/** Answers the next browser confirm and returns its message. */
async function answerNextDialog(page: Page, accept: boolean): Promise<string> {
  const dialog = await page.waitForEvent("dialog");
  const message = dialog.message();
  if (accept) {
    await dialog.accept();
  } else {
    await dialog.dismiss();
  }
  return message;
}

/** Queued texts shown on screen, top to bottom. Collapsed rows are not rendered. */
async function visibleQueueOrder(page: Page, candidates: string[]): Promise<string[]> {
  const shown: Array<{ text: string; y: number }> = [];
  for (const text of candidates) {
    const row = page.getByText(text, { exact: true });
    if ((await row.count()) === 0 || !(await row.isVisible())) continue;
    const box = await row.boundingBox();
    if (box) shown.push({ text, y: box.y });
  }
  return shown.sort((a, b) => a.y - b.y).map((entry) => entry.text);
}

async function expectVisibleQueue(page: Page, candidates: string[], expected: string[]) {
  await expect.poll(() => visibleQueueOrder(page, candidates)).toEqual(expected);
}

async function queueDraft(page: Page, text: string): Promise<void> {
  await composerLocator(page).fill(text);
  await expectComposerDraft(page, text);
  await page.getByRole("button", { name: "Queue message", exact: true }).tap();
  await expectComposerDraft(page, "");
}

async function chooseRowAction(page: Page, messageId: string, action: string): Promise<void> {
  await page.getByTestId(`composer-queue-menu-${messageId}`).tap();
  const item = page.getByRole("menuitem", { name: action, exact: true });
  await expect(item).toBeVisible();
  await item.tap();
  await expect(item).toBeHidden();
}

async function expectImageLoaded(image: Locator): Promise<void> {
  await expect(image).toBeAttached({ timeout: 15_000 });
  await expect
    .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth), {
      timeout: 15_000,
    })
    .toBeGreaterThan(0);
}

test.describe("Daemon-owned message queue on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  let agent: MockAgentSetup | null = null;
  let observer: QueueObserverClient | null = null;

  test.beforeEach(async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    await configureComposerQueueSend(page);
    agent = await startRunningMockAgent(page, {
      prefix: `queue-controls-${testInfo.workerIndex}-`,
      model: "one-minute-stream",
      prompt: "Keep running while messages queue up.",
    });
    observer = await connectDaemonClient<QueueObserverClient>({ clientIdPrefix: "queue-observer" });
  });

  test.afterEach(async () => {
    await observer?.close().catch(() => undefined);
    await agent?.cleanup();
    observer = null;
    agent = null;
  });

  test("reorders, deletes, pauses, collapses, and clears the queue", async ({ page }) => {
    const { agentId } = agent!;
    const daemon = observer!;
    const texts = ["Alpha queued", "Bravo queued", "Charlie queued", "Delta queued"];

    await test.step("queued messages show in order under a counted header", async () => {
      await queueDraft(page, "Alpha queued");
      await queueDraft(page, "Bravo queued");
      await expect(page.getByText("Queue · 2", { exact: true })).toBeVisible();
      await expectVisibleQueue(page, texts, ["Alpha queued", "Bravo queued"]);
    });

    // The daemon holds the queue: a client that never queued anything sees the same entries.
    let entries = await expectDaemonQueue(daemon, agentId, ["Alpha queued", "Bravo queued"]);
    const [alpha, bravo] = entries;

    await test.step("row menu moves an entry to the top and back down", async () => {
      await chooseRowAction(page, bravo.id, "Move to top");
      await expectVisibleQueue(page, texts, ["Bravo queued", "Alpha queued"]);
      await expectDaemonQueue(daemon, agentId, ["Bravo queued", "Alpha queued"]);

      await chooseRowAction(page, bravo.id, "Move down");
      await expectVisibleQueue(page, texts, ["Alpha queued", "Bravo queued"]);
      await expectDaemonQueue(daemon, agentId, ["Alpha queued", "Bravo queued"]);
    });

    await test.step("pausing shows in the header and on the daemon, resuming clears it", async () => {
      await page.getByTestId("composer-queue-pause-toggle").tap();
      await expect(page.getByText("Queue paused · 2", { exact: true })).toBeVisible();
      await expectDaemonQueuePaused(daemon, agentId, true);

      await page.getByTestId("composer-queue-pause-toggle").tap();
      await expect(page.getByText("Queue · 2", { exact: true })).toBeVisible();
      await expectDaemonQueuePaused(daemon, agentId, false);
    });

    await test.step("a queue past three entries collapses to two rows and expands", async () => {
      await queueDraft(page, "Charlie queued");
      await queueDraft(page, "Delta queued");
      await expect(page.getByText("Queue · 4", { exact: true })).toBeVisible();
      entries = await expectDaemonQueue(daemon, agentId, texts);

      const toggle = page.getByTestId("composer-queue-collapse-toggle");
      await expect(toggle).toHaveText("Show 2 more");
      await expectVisibleQueue(page, texts, ["Alpha queued", "Bravo queued"]);

      await toggle.tap();
      await expect(toggle).toHaveText("Show less");
      await expectVisibleQueue(page, texts, texts);

      await toggle.tap();
      await expect(toggle).toHaveText("Show 2 more");
      await expectVisibleQueue(page, texts, ["Alpha queued", "Bravo queued"]);
    });

    await test.step("deleting a row removes it everywhere", async () => {
      await chooseRowAction(page, alpha.id, "Delete");
      await expect(page.getByText("Queue · 3", { exact: true })).toBeVisible();
      await expect(page.getByTestId("composer-queue-collapse-toggle")).toHaveCount(0);
      await expectVisibleQueue(page, texts, ["Bravo queued", "Charlie queued", "Delta queued"]);
      await expectDaemonQueue(daemon, agentId, ["Bravo queued", "Charlie queued", "Delta queued"]);
    });

    await test.step("clearing asks first and empties the queue only when confirmed", async () => {
      const declined = answerNextDialog(page, false);
      await page.getByTestId("composer-queue-clear").tap();
      expect(await declined).toContain("Every queued message for this agent will be removed.");
      await expect(page.getByText("Queue · 3", { exact: true })).toBeVisible();
      await expectDaemonQueue(daemon, agentId, ["Bravo queued", "Charlie queued", "Delta queued"]);

      const accepted = answerNextDialog(page, true);
      await page.getByTestId("composer-queue-clear").tap();
      await accepted;
      await expect(page.getByTestId("composer-queue-pause-toggle")).toHaveCount(0);
      await expectDaemonQueue(daemon, agentId, []);
    });
  });

  test("keeps a queued image through edit and shows it on the sent message", async ({ page }) => {
    const { agentId } = agent!;
    const daemon = observer!;
    const text = "Describe the queued image";
    const composerImage = page.getByTestId("composer-image-attachment-pill").locator("img");

    await attachImageFromMenu(page, QUEUE_IMAGE);
    await expectImageLoaded(composerImage);
    await queueDraft(page, text);
    await expect(page.getByTestId("composer-image-attachment-pill")).toHaveCount(0);
    const [queued] = await expectDaemonQueue(daemon, agentId, [text]);
    expect(queued.imageCount).toBe(1);

    await test.step("Edit puts the text and a loading image back in the composer", async () => {
      await chooseRowAction(page, queued.id, "Edit");
      await expectComposerDraft(page, text);
      await expect(page.getByTestId("composer-queue-pause-toggle")).toHaveCount(0);
      await expectDaemonQueue(daemon, agentId, []);
      await expectImageLoaded(composerImage);
    });

    await queueDraft(page, text);
    const [requeued] = await expectDaemonQueue(daemon, agentId, [text]);
    expect(requeued.imageCount).toBe(1);

    await test.step("the dispatched message shows the image once the agent stops", async () => {
      await page.getByRole("button", { name: "Stop agent", exact: true }).tap();
      await expectDaemonQueue(daemon, agentId, []);
      const sentRow = page.getByTestId("user-message").filter({ hasText: text });
      await expect(sentRow).toBeVisible({ timeout: 30_000 });
      await expectImageLoaded(
        sentRow.getByRole("button", { name: "Open image attachment" }).locator("img"),
      );
    });
  });
});
