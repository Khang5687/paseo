import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";

interface UrgentFixture {
  project: SeededWorkspace;
  waitingId: string;
  workingId: string;
}

// The seeded workspace is the older one and gets the agent that waits on you; the newer one
// gets an agent that keeps working. Created order puts the newer one first; Urgent first must
// flip that.
async function seedWaitingAndWorking(): Promise<UrgentFixture> {
  const project = await seedWorkspace({ repoPrefix: "urgent-sort-", title: "Waiting work" });
  const working = await project.client.createWorkspace({
    source: { kind: "directory", path: project.repoPath, projectId: project.projectId },
    title: "Working work",
  });
  if (!working.workspace) throw new Error(working.error ?? "Failed to seed a second workspace");
  await project.client.createAgent({
    provider: "mock",
    cwd: project.repoPath,
    workspaceId: project.workspaceId,
    title: "Needs input agent",
    modeId: "load-test",
    model: "thirty-minute-stream",
    initialPrompt: "emit a synthetic plan approval",
  });
  await project.client.createAgent({
    provider: "mock",
    cwd: project.repoPath,
    workspaceId: working.workspace.id,
    title: "Working agent",
    modeId: "load-test",
    model: "thirty-minute-stream",
    initialPrompt: "keep streaming",
  });
  return { project, waitingId: project.workspaceId, workingId: working.workspace.id };
}

function rowTestId(workspaceId: string): string {
  return `sidebar-workspace-row-${getServerId()}:${workspaceId}`;
}

function rows(page: Page, fixture: UrgentFixture): Locator {
  return page.locator(
    `[data-testid="${rowTestId(fixture.waitingId)}"], [data-testid="${rowTestId(fixture.workingId)}"]`,
  );
}

async function rowOrder(locator: Locator): Promise<string[]> {
  return locator.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-testid") ?? ""),
  );
}

async function selectWorkspaceSort(page: Page, name: "Created" | "Urgent first"): Promise<void> {
  await page.getByLabel("Display preferences", { exact: true }).click();
  await page.getByRole("menuitem", { name: /^Sort/ }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}

async function expectOrder(page: Page, fixture: UrgentFixture, first: string, second: string) {
  await expect
    .poll(() => rowOrder(rows(page, fixture)), { timeout: 30_000 })
    .toEqual([rowTestId(first), rowTestId(second)]);
}

test.describe("Urgent first sort", () => {
  test("a chat waiting on you sorts above a newer working chat", async ({ page }) => {
    const fixture = await seedWaitingAndWorking();
    try {
      await page.setViewportSize({ width: 1000, height: 800 });
      await gotoAppShell(page);
      await selectWorkspaceSort(page, "Created");
      await expectOrder(page, fixture, fixture.workingId, fixture.waitingId);

      await selectWorkspaceSort(page, "Urgent first");
      await expectOrder(page, fixture, fixture.waitingId, fixture.workingId);
      await page.screenshot({ path: test.info().outputPath("desktop-urgent-sort.png") });
    } finally {
      await fixture.project.cleanup();
    }
  });

  test.describe("compact", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

    test("the phone sidebar uses the same order", async ({ page }) => {
      const fixture = await seedWaitingAndWorking();
      try {
        await gotoAppShell(page);
        await page.getByRole("button", { name: "Open menu", exact: true }).tap();
        await selectWorkspaceSort(page, "Urgent first");
        await expectOrder(page, fixture, fixture.waitingId, fixture.workingId);
        await page.screenshot({ path: test.info().outputPath("compact-urgent-sort.png") });
      } finally {
        await fixture.project.cleanup();
      }
    });
  });
});
