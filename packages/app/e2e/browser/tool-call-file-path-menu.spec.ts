import { realpath } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { expectComposerVisible } from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

// A tool call that names a file (Read, Edit, Write) has the file menu. On a phone browser it opens
// from the long-press that fires `contextmenu`; actions are reached by tapping.
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

// The mock stream reads this workspace-relative file first.
const READ_FILE = "packages/app/src/components/conversation-list.tsx";

test("a tool call that reads a file copies the file's name, relative and full path from its menu", async ({
  context,
  page,
}) => {
  test.setTimeout(120_000);
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "tool-call-file-menu-",
    title: "Tool-call file menu",
    model: "ten-second-stream",
  });
  try {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openAgentRoute(page, { workspaceId: agent.workspaceId, agentId: agent.agentId });
    await expectComposerVisible(page);
    await agent.client.sendAgentMessage(agent.agentId, "Read the conversation list.");

    const badge = page
      .getByTestId("tool-call-badge")
      .filter({ hasText: "conversation-list.tsx" })
      .first();
    await expect(badge).toBeVisible({ timeout: 30_000 });

    const openMenu = async () => {
      // Mobile Chrome turns a long press into a `contextmenu` mouse event at the finger.
      await badge.getByRole("button").first().dispatchEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
      });
      const menu = page.getByTestId("file-path-menu-content");
      await expect(menu).toBeVisible();
      return menu;
    };
    const copied = () => page.evaluate(() => navigator.clipboard.readText());

    await (await openMenu()).getByTestId("file-path-menu-copy-relative-path").tap();
    await expect.poll(copied).toBe(READ_FILE);
    await expect(page.getByTestId("file-path-menu-content")).toHaveCount(0);

    await (await openMenu()).getByTestId("file-path-menu-copy-full-path").tap();
    const workspaceRoot = await realpath(agent.cwd);
    await expect.poll(copied).toBe(path.join(workspaceRoot, READ_FILE));
    await expect(page.getByTestId("file-path-menu-content")).toHaveCount(0);

    await (await openMenu()).getByTestId("file-path-menu-copy-file-name").tap();
    await expect.poll(copied).toBe("conversation-list.tsx");
  } finally {
    await agent.cleanup();
  }
});
