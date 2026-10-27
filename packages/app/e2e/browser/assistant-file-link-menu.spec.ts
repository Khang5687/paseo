import { mkdtempSync } from "node:fs";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

// Fork #15: a file path in an agent reply has its own menu (copy file name, relative and full
// path; open in editor and reveal on desktop). On a phone browser the menu opens from the
// long-press that fires `contextmenu`; actions are reached by tapping.
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

// A `~/` path is expanded with the daemon's home directory, which the daemon reports.
const daemonHome = mkdtempSync(path.join(tmpdir(), "paseo-file-link-home-"));
test.use({ e2eDaemonEnvironment: { HOME: daemonHome, USERPROFILE: daemonHome } });

// The reply names the file by basename only, so the menu must act on the daemon-resolved path.
const FILE_TOKEN = "linked.ts:3";

// The mock provider answers a title prompt with the user prompt's first line, rendered as
// Markdown, so the token arrives as an inline-code file link in the agent's reply.
function promptMentioning(token: string): string {
  return [
    "Generate a title and a git branch name for a coding agent from the user prompt and attachments.",
    "Return JSON only with fields 'title' and 'branch'.",
    "",
    "<user-prompt>",
    `Open \`${token}\` now`,
    "</user-prompt>",
  ].join("\n");
}

async function longPressFileLink(page: Page, token = FILE_TOKEN) {
  const link = page.getByText(token, { exact: true });
  await expect(link).toBeVisible({ timeout: 15_000 });
  // Mobile Chrome turns a long press on a link into a `contextmenu` mouse event at the finger.
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
  // On a phone the menu is a bottom sheet; its items live in the sheet's content.
  const menu = page.getByTestId("file-path-menu-content");
  await expect(menu).toBeVisible();
  return menu;
}

test("a file path in an agent reply copies its resolved name, relative and full path from its menu", async ({
  context,
  page,
}) => {
  const workspace = await seedMockAgentWorkspace({
    repoPrefix: "assistant-file-link-menu-",
    title: "File link menu",
    initialPrompt: promptMentioning(FILE_TOKEN),
  });
  try {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await mkdir(path.join(workspace.cwd, "src"), { recursive: true });
    await writeFile(path.join(workspace.cwd, "src", "linked.ts"), "one\ntwo\nthree\n", "utf8");
    const resolvedFile = path.join(await realpath(workspace.cwd), "src", "linked.ts");
    await openAgentRoute(page, workspace);

    const menu = await longPressFileLink(page);
    // A plain browser has no desktop editor bridge, so only the copy actions are offered.
    await expect(menu.getByTestId("file-path-menu-open-in-editor")).toHaveCount(0);
    await expect(menu.getByTestId("file-path-menu-reveal")).toHaveCount(0);

    await menu.getByTestId("file-path-menu-copy-relative-path").tap();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe("src/linked.ts");
    await expect(page.getByText("Copied File path")).toBeVisible();
    await expect(page.getByTestId("file-path-menu-content")).toHaveCount(0);

    await page.evaluate(() => navigator.clipboard.writeText(""));
    const reopened = await longPressFileLink(page);
    await reopened.getByTestId("file-path-menu-copy-full-path").tap();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(resolvedFile);
    await expect(page.getByTestId("file-path-menu-content")).toHaveCount(0);

    const nameMenu = await longPressFileLink(page);
    await nameMenu.getByTestId("file-path-menu-copy-file-name").tap();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("linked.ts");
    await expect(page.getByText("Copied File name")).toBeVisible();
  } finally {
    await workspace.cleanup();
  }
});

test("a home-relative file path copies its full path under the daemon's home directory", async ({
  context,
  page,
}) => {
  const token = "~/notes/todo.md";
  const workspace = await seedMockAgentWorkspace({
    repoPrefix: "assistant-file-link-home-",
    title: "Home file link",
    initialPrompt: promptMentioning(token),
  });
  try {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openAgentRoute(page, workspace);

    const menu = await longPressFileLink(page, token);
    await expect(menu.getByTestId("file-path-menu-copy-relative-path")).toHaveCount(0);
    await menu.getByTestId("file-path-menu-copy-full-path").tap();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(path.join(daemonHome, "notes", "todo.md"));
  } finally {
    await workspace.cleanup();
  }
});
