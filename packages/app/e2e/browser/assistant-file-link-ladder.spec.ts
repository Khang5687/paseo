import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

// A bare file name in an agent reply finds the file even when Git ignores it, asks which one when
// several match, and only says "No file found" when nothing matches. Driven by taps at phone width.
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

function replyLink(page: Page, token: string) {
  return page.getByTestId("assistant-message").getByText(token, { exact: true });
}

async function seedReply(prefix: string, token: string) {
  return seedMockAgentWorkspace({
    repoPrefix: prefix,
    title: "File link ladder",
    initialPrompt: "Where is it?",
    featureValues: { mockAssistantResponse: `It is in \`${token}\`.` },
  });
}

async function writeIn(cwd: string, file: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
  await writeFile(path.join(cwd, file), content, "utf8");
}

test("a bare name opens a file Git ignores", async ({ page }) => {
  const workspace = await seedReply("assistant-file-link-ignored-", "render-report.txt");
  try {
    await writeIn(workspace.cwd, ".gitignore", "out/\n");
    await writeIn(workspace.cwd, "out/render-report.txt", "Report from the ignored out folder\n");
    await workspace.client.waitForFinish(workspace.agentId, 30_000);
    await openAgentRoute(page, workspace);

    await replyLink(page, "render-report.txt").tap();
    await expect(page.getByText("Report from the ignored out folder")).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId("file-link-chooser")).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("ignored-file-opened.png") });
  } finally {
    await workspace.cleanup();
  }
});

test("a name that matches two files asks which one to open", async ({ page }) => {
  const workspace = await seedReply("assistant-file-link-picker-", "notes.txt");
  try {
    await writeIn(workspace.cwd, "docs/notes.txt", "Notes from docs\n");
    await writeIn(workspace.cwd, "drafts/notes.txt", "Notes from drafts\n");
    await workspace.client.waitForFinish(workspace.agentId, 30_000);
    await openAgentRoute(page, workspace);

    await replyLink(page, "notes.txt").tap();
    // On a phone the sheet is a bottom sheet whose testID is not an ancestor of its rows.
    await expect(page.getByText("Which file do you mean?", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    const rows = page.getByTestId(/^file-link-chooser-row-/);
    await expect(rows).toHaveCount(2);
    await page.screenshot({ path: test.info().outputPath("file-chooser.png") });

    await page.getByTestId("file-link-chooser-row-drafts/notes.txt").tap();
    await expect(page.getByText("Notes from drafts")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Notes from docs")).toHaveCount(0);
    await expect(rows).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("picked-file-opened.png") });
  } finally {
    await workspace.cleanup();
  }
});

test("a name no step finds shows the not-found toast", async ({ page }) => {
  const workspace = await seedReply("assistant-file-link-missing-", "missing-file.txt");
  try {
    await workspace.client.waitForFinish(workspace.agentId, 30_000);
    await openAgentRoute(page, workspace);

    await replyLink(page, "missing-file.txt").tap();
    await expect(page.getByTestId("assistant-file-link-not-found-toast")).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId("file-link-chooser")).toHaveCount(0);
  } finally {
    await workspace.cleanup();
  }
});

test.describe("on a desktop window", () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

  test("a name that matches two files asks which one to open", async ({ page }) => {
    const workspace = await seedReply("assistant-file-link-picker-desktop-", "notes.txt");
    try {
      await writeIn(workspace.cwd, "docs/notes.txt", "Notes from docs\n");
      await writeIn(workspace.cwd, "drafts/notes.txt", "Notes from drafts\n");
      await workspace.client.waitForFinish(workspace.agentId, 30_000);
      await openAgentRoute(page, workspace);

      await replyLink(page, "notes.txt").click();
      const chooser = page.getByTestId("file-link-chooser");
      await expect(chooser.getByTestId(/^file-link-chooser-row-/)).toHaveCount(2, {
        timeout: 30_000,
      });
      await page.screenshot({ path: test.info().outputPath("file-chooser-desktop.png") });

      await chooser.getByTestId("file-link-chooser-row-docs/notes.txt").click();
      await expect(page.getByText("Notes from docs")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("file-link-chooser")).toHaveCount(0);
    } finally {
      await workspace.cleanup();
    }
  });
});
