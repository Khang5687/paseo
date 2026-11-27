import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { openAgentRoute } from "../support/helpers/mock-agent";
import { projectEquivalenceViewKey } from "../support/helpers/project-view-key";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { seedRunningSubagent } from "../support/helpers/subagents";

// A chat whose turn ended and that only waits on its background jobs or subagents shows a blue
// hourglass, not the working ring, and says what it waits on. Everything that asks you is the
// palette purple.

// theme.colors.palette.purple[500].
const ASKING_PURPLE = "rgb(168, 85, 247)";

const QUESTION_REPLY = [
  "One thing before I build.",
  "",
  "❓ **Q300** - **Icons**: round or square?",
  "",
  "➡️ square",
].join("\n");

async function seedChat(
  prefix: string,
  agent: { prompt: string; responses?: string[] },
): Promise<{ workspace: SeededWorkspace; agentId: string }> {
  const workspace = await seedWorkspace({ repoPrefix: prefix });
  try {
    const created = await workspace.client.createAgent({
      provider: "mock",
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: "Waiting chat",
      modeId: "load-test",
      model: "e2e-fast-stream",
      initialPrompt: agent.prompt,
      featureValues: agent.responses ? { mockAssistantResponses: agent.responses } : undefined,
    });
    await workspace.client.waitForFinish(created.id, 30_000);
    return { workspace, agentId: created.id };
  } catch (error) {
    await workspace.cleanup();
    throw error;
  }
}

function workspaceRow(page: Page, workspace: SeededWorkspace): Locator {
  return page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspace.workspaceId}`);
}

function railItem(page: Page, workspace: SeededWorkspace): Locator {
  return page.getByTestId(
    `sidebar-project-rail-item-${projectEquivalenceViewKey(workspace.projectKey)}`,
  );
}

async function shot(page: Page, name: string, target?: Locator): Promise<void> {
  const path = test.info().outputPath(name);
  await (target ?? page).screenshot({ path });
  await test.info().attach(name, { path, contentType: "image/png" });
}

async function expectHourglass(row: Locator): Promise<void> {
  await expect(row.getByTestId("workspace-status-indicator-waiting")).toBeVisible({
    timeout: 30_000,
  });
  await expect(row.getByTestId("workspace-status-indicator-running")).toHaveCount(0);
}

/** The waiting dot stays lit: a blinking dot would dip below full opacity within a second. */
async function expectSteady(dot: Locator): Promise<void> {
  const samples: string[] = [];
  for (let index = 0; index < 6; index += 1) {
    samples.push(await dot.evaluate((element) => getComputedStyle(element).opacity));
    await dot.page().waitForTimeout(200);
  }
  expect(new Set(samples)).toEqual(new Set(["1"]));
}

test.describe("Chat waiting status", () => {
  test.describe.configure({ timeout: 180_000 });

  test.describe("desktop", () => {
    test.use({ viewport: { width: 1280, height: 800 } });

    test("a chat waiting on a background job shows the hourglass and says why", async ({
      page,
    }) => {
      const { workspace, agentId } = await seedChat("chat-waiting-job-", {
        prompt: "Start a synthetic background job.",
      });
      try {
        await gotoAppShell(page);
        const row = workspaceRow(page, workspace);
        await expectHourglass(row);
        await row.getByTestId("workspace-status-indicator-waiting").hover();
        await expect(page.getByTestId("workspace-status-waiting-tooltip")).toHaveText(
          "Waiting on 1 background task",
        );
        await shot(page, "desktop-row-waiting-job.png", row);

        await openAgentRoute(page, { workspaceId: workspace.workspaceId, agentId });
        const pill = page.getByTestId("background-work-segment-0");
        await expect(pill).toHaveText("Waiting on 1 background task", { timeout: 30_000 });
        await shot(page, "desktop-footer-waiting-job.png", page.getByTestId("background-work"));
        await shot(page, "desktop-waiting-job.png");
      } finally {
        await workspace.cleanup();
      }
    });

    test("a chat waiting on a subagent shows the hourglass and a steady rail dot", async ({
      page,
    }) => {
      const parent = await seedChat("chat-waiting-subagent-", { prompt: "Plan the work." });
      const other = await seedChat("chat-waiting-other-", { prompt: "Say hi." });
      try {
        await seedRunningSubagent(
          {
            client: parent.workspace.client,
            repoPath: parent.workspace.repoPath,
            workspaceId: parent.workspace.workspaceId,
          },
          { parentId: parent.agentId, title: "Busy child" },
        );
        await gotoAppShell(page);
        const row = workspaceRow(page, parent.workspace);
        await expectHourglass(row);
        await row.getByTestId("workspace-status-indicator-waiting").hover();
        await expect(page.getByTestId("workspace-status-waiting-tooltip")).toHaveText(
          "Waiting on 1 subagent",
        );
        // The old "N sub-agents working" line is gone; the desktop says it in the tooltip.
        await expect(row).not.toContainText("working");

        const rail = railItem(page, parent.workspace);
        const dot = rail.getByTestId("sidebar-project-status-dot-waiting");
        await expect(dot).toHaveCount(1, { timeout: 30_000 });
        await expect(rail.getByTestId("sidebar-project-status-dot-running")).toHaveCount(0);
        await expect(rail).toHaveAttribute("aria-label", /Waiting: 1/);
        await expectSteady(dot);
        await expect(railItem(page, other.workspace)).toBeVisible();

        await openAgentRoute(page, {
          workspaceId: parent.workspace.workspaceId,
          agentId: parent.agentId,
        });
        await expect(page.getByText("Waiting on 1 subagent").first()).toBeVisible({
          timeout: 30_000,
        });
        await shot(page, "desktop-waiting-subagent.png");
      } finally {
        await parent.workspace.cleanup();
        await other.workspace.cleanup();
      }
    });

    test("a chat asking you is the same purple on its row and its questions pill", async ({
      page,
    }) => {
      const { workspace, agentId } = await seedChat("chat-waiting-asks-", {
        prompt: "Plan the icons.",
        responses: [QUESTION_REPLY],
      });
      try {
        await gotoAppShell(page);
        const row = workspaceRow(page, workspace);
        const alert = row.getByTestId("workspace-status-indicator-needs_input");
        await expect(alert).toBeVisible({ timeout: 30_000 });
        await expect(alert.locator("svg")).toHaveCSS("fill", ASKING_PURPLE);
        await shot(page, "desktop-row-asking.png", row);

        await openAgentRoute(page, { workspaceId: workspace.workspaceId, agentId });
        const pill = page.getByTestId("open-questions-pill");
        await expect(pill).toContainText("1 open question", { timeout: 30_000 });
        const mark = page.getByTestId("open-questions-pill-segment-0").locator("div").first();
        await expect(mark).toHaveCSS("background-color", ASKING_PURPLE);
        await shot(page, "desktop-footer-asking.png", pill);
      } finally {
        await workspace.cleanup();
      }
    });
  });

  test.describe("phone", () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

    test("the row's second line says what the chat waits on", async ({ page }) => {
      const { workspace, agentId } = await seedChat("chat-waiting-phone-", {
        prompt: "Start a synthetic background job.",
      });
      try {
        await seedRunningSubagent(
          {
            client: workspace.client,
            repoPath: workspace.repoPath,
            workspaceId: workspace.workspaceId,
          },
          { parentId: agentId, title: "Busy child" },
        );
        await gotoAppShell(page);
        await page.getByRole("button", { name: "Open menu", exact: true }).tap();
        const row = workspaceRow(page, workspace);
        await expectHourglass(row);
        await expect(row.getByTestId("sidebar-workspace-waiting-for")).toHaveText(
          "Waiting on 1 background task and 1 subagent",
        );
        await shot(page, "phone-sidebar-waiting.png");

        await row.tap();
        const line = page.getByTestId("composer-status-line");
        await expect(line).toContainText("Waiting on 1 background task", { timeout: 30_000 });
        await expect(line).toContainText("Waiting on 1 subagent");
        await shot(page, "phone-footer-waiting.png");
      } finally {
        await workspace.cleanup();
      }
    });
  });
});
