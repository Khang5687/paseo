import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "../support/fixtures";
import { composerLocator, expectComposerVisible } from "../support/helpers/composer";
import {
  openAgentRoute,
  seedMockAgentWorkspace,
  type MockAgentWorkspace,
} from "../support/helpers/mock-agent";

// The compact header: 8 px top padding plus the 56 px bar, with no safe area on web.
const COMPACT_HEADER_BOTTOM = 64;

test.describe("files sent to this device", () => {
  let agent: MockAgentWorkspace;

  test.beforeEach(async () => {
    agent = await seedMockAgentWorkspace({ repoPrefix: "sent-file-note-", title: "Sent file" });
  });

  test.afterEach(async () => {
    await agent?.cleanup();
  });

  test("a tap on a sent file notes it under the header and opens it from the note", async ({
    page,
  }) => {
    const fileName = "build-notes.txt";
    const sentFilePath = join(agent.cwd, fileName);
    await writeFile(sentFilePath, "Release notes for the build.\n");
    await page.setViewportSize({ width: 390, height: 844 });
    await openAgentRoute(page, agent);
    await expectComposerVisible(page);

    // Play the tap on "<file> is ready" the way the web notification delivers it.
    await page.evaluate(
      (data) => {
        globalThis.dispatchEvent(
          new CustomEvent("paseo:web-notification-click", { detail: { data }, cancelable: true }),
        );
      },
      { serverId: process.env.E2E_SERVER_ID, sentFilePath },
    );

    const note = page.getByTestId("download-note");
    await expect(note).toContainText(`${fileName} saved`);
    // It stays on the chat, under the header, clear of the composer.
    await expectComposerVisible(page);
    const noteBox = (await note.boundingBox())!;
    const composerBox = (await composerLocator(page).boundingBox())!;
    expect(Math.abs(noteBox.y - COMPACT_HEADER_BOTTOM)).toBeLessThan(1);
    expect(noteBox.y + noteBox.height).toBeLessThan(composerBox.y);
    // Install is for an APK on Android only.
    await expect(page.getByTestId("download-note-install")).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("sent-file-note.png") });

    await page.getByTestId("download-note-open").click();
    await expect(page).toHaveURL(/\/saved\/file/);
    await expect(page.getByText("Release notes for the build.")).toBeVisible();
    await expect(note).toHaveCount(0);
  });
});
