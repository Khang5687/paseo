import { expect, test, type Page } from "../support/fixtures";
import { expectComposerEditable, fillComposerDraft } from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { getServerId } from "../support/helpers/server-id";
import {
  closeMobileAgentSidebar,
  expectMobileAgentSidebarVisible,
  openMobileAgentSidebar,
} from "../support/helpers/sidebar";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

function workspaceRow(page: Page, workspaceId: string) {
  return page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspaceId}`);
}

async function openSidebar(page: Page) {
  await openMobileAgentSidebar(page);
  await expectMobileAgentSidebarVisible(page);
}

async function tapWorkspace(page: Page, workspaceId: string) {
  await workspaceRow(page, workspaceId).tap();
  await expect(page).toHaveURL(new RegExp(`/workspace/${workspaceId}`));
}

test("a workspace left holding an unsent prompt is marked in the sidebar until the prompt is cleared", async ({
  page,
}) => {
  const drafted = await seedMockAgentWorkspace({
    repoPrefix: "sidebar-unsent-prompt-",
    title: "Drafted agent",
  });
  const other = await seedMockAgentWorkspace({
    repoPrefix: "sidebar-unsent-prompt-other-",
    title: "Other agent",
  });

  try {
    await openAgentRoute(page, { workspaceId: drafted.workspaceId, agentId: drafted.agentId });
    await expectComposerEditable(page);
    await fillComposerDraft(page, "Refactor the parser before lunch");

    await openSidebar(page);
    await tapWorkspace(page, other.workspaceId);

    await openSidebar(page);
    const draftedRow = workspaceRow(page, drafted.workspaceId);
    const otherRow = workspaceRow(page, other.workspaceId);
    await expect(draftedRow.getByTestId("workspace-status-indicator-draft")).toBeVisible();
    await expect(draftedRow).toHaveAccessibleName(/Unsent draft/);
    await expect(otherRow.getByTestId("workspace-status-indicator-draft")).toHaveCount(0);
    await expect(otherRow).not.toHaveAccessibleName(/Unsent draft/);

    // Going back finds the prompt where it was left; emptying it removes the mark.
    await tapWorkspace(page, drafted.workspaceId);
    const composer = page.getByRole("textbox", { name: "Message agent..." }).first();
    await expect(composer).toHaveValue("Refactor the parser before lunch");
    await fillComposerDraft(page, "   ");

    await openSidebar(page);
    await expect(draftedRow.getByTestId("workspace-status-indicator-draft")).toHaveCount(0);
    await expect(draftedRow.getByTestId("workspace-status-indicator-done")).toBeVisible();
    await expect(draftedRow).not.toHaveAccessibleName(/Unsent draft/);
    await closeMobileAgentSidebar(page);
  } finally {
    await other.cleanup();
    await drafted.cleanup();
  }
});
