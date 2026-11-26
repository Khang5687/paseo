import { expect } from "@playwright/test";
import { test } from "../support/fixtures";
import { buildAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { startForkAgentUiDaemon } from "./fork-agent-ui-daemon";

// Guards fork #51 (single questions render as formatted text with one-tap answers) and
// #18 (an answer containing commas reaches the provider as one answer, not split).
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test("a single question shows formatted text and one tap sends a comma answer intact", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const daemon = await startForkAgentUiDaemon();
  try {
    const session = await seedMockAgentWorkspace({
      port: daemon.port,
      repoPrefix: "question-card-",
      title: "Question card e2e",
      initialPrompt: "Emit synthetic question.",
    });
    try {
      await daemon.registerHost(page);
      await page.goto(buildAgentRoute(session.workspaceId, session.agentId, daemon.serverId), {
        waitUntil: "commit",
      });
      const card = page.getByTestId("question-form-card");
      await expect(card).toBeVisible({ timeout: 120_000 });

      const question = card.getByTestId("question-form-current-question");
      await expect(question).toHaveText("Ship the hotfix to main now?");
      const bold = question.getByText("the hotfix", { exact: true });
      expect(
        Number(await bold.evaluate((node) => getComputedStyle(node).fontWeight)),
      ).toBeGreaterThanOrEqual(600);
      const code = question.getByText("main", { exact: true });
      expect(await code.evaluate((node) => getComputedStyle(node).fontFamily)).toMatch(/mono/i);

      // One tap answers: no option-then-Submit form.
      await expect(card.getByTestId("question-form-primary-action")).toHaveCount(0);
      await card.getByRole("button", { name: "Yes, ship it, today" }).tap();
      await expect(card).toHaveCount(0);

      await expect.poll(() => daemon.questionResponses.length).toBe(1);
      expect(daemon.questionResponses[0]).toMatchObject({
        behavior: "allow",
        updatedInput: {
          answers: { ship: "Yes, ship it, today" },
          answerLists: { ship: ["Yes, ship it, today"] },
        },
      });
      await page.screenshot({ path: testInfo.outputPath("question-card-answered.png") });
    } finally {
      await session.cleanup();
    }
  } finally {
    await daemon.stop();
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach("fork-ui-daemon", {
        body: daemon.output.join(""),
        contentType: "text/plain",
      });
    }
  }
});
