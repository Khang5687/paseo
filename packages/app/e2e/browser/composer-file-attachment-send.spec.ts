import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { expectAgentIdle } from "../support/helpers/agent-stream";
import { gateNextAgentMessage } from "../support/helpers/agent-message-gate";
import {
  attachFileFromMenu,
  attachImageFromMenu,
  composerLocator,
  expectComposerVisible,
} from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

const ARCHIVE = {
  name: "Archive.zip",
  mimeType: "application/zip",
  buffer: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64 * 1024, 7)]),
};
const IMAGE = {
  name: "logo.png",
  mimeType: "image/png",
  buffer: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  ),
};

async function uploadedArchives(): Promise<string[]> {
  const uploads = path.join(process.env.E2E_PASEO_HOME!, "uploads");
  if (!existsSync(uploads)) return [];
  return (await readdir(uploads))
    .map((dir) => path.join(uploads, dir, ARCHIVE.name))
    .filter((file) => existsSync(file));
}

async function typeAtEnd(page: Page, text: string): Promise<void> {
  await composerLocator(page).focus();
  await page.keyboard.press("End");
  await page.keyboard.type(text);
}

test("a sent file attachment stays on the host while the send is in flight", async ({ page }) => {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "file-attach-send-",
    title: "File attachment send",
  });
  try {
    // Holds the send like a slow relay round trip, so draft sync pushes the cleared composer first.
    const gate = await gateNextAgentMessage(page);
    await openAgentRoute(page, { workspaceId: agent.workspaceId, agentId: agent.agentId });
    await expectComposerVisible(page);
    await attachImageFromMenu(page, IMAGE);
    await typeAtEnd(page, " this is the logo ");
    await attachFileFromMenu(page, ARCHIVE);
    await expect(page.getByTestId("composer-file-attachment-pill")).toContainText(ARCHIVE.name);
    await expect.poll(uploadedArchives).toHaveLength(1);
    await typeAtEnd(page, " has the other assets");
    // Past the draft push interval, so the clear goes out on its own push.
    await page.waitForTimeout(1_500);
    await composerLocator(page).press("Enter");

    await gate.waitForRequest();
    await page.waitForTimeout(2_000);
    expect(await uploadedArchives()).toHaveLength(1);

    gate.accept();
    await expectAgentIdle(page);
    expect(await uploadedArchives()).toHaveLength(1);
  } finally {
    await agent.cleanup();
  }
});
