import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { expect, test } from "../support/fixtures";
import { primeAdditionalPage } from "../support/helpers/archive-tab";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import {
  chooseQuestionOption,
  expectQuestionOptionSelected,
  waitForQuestionPrompt,
} from "../support/helpers/questions";

// A question box's picks reach a second device, and "Send what I have" answers the box with the
// open questions marked "No answer yet" (docs/questions.md "Question boxes").

type PendingPermissions = Partial<Pick<AgentSnapshotPayload, "pendingPermissions">>;

test("a half-filled question box shows on a second device and sends what it has", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const workspace = await seedMockAgentWorkspace({
    repoPrefix: "question-box-drafts-",
    title: "Question box drafts",
    initialPrompt: "Emit synthetic questions.",
  });
  const phone = await page.context().newPage();
  try {
    await primeAdditionalPage(phone);
    await phone.setViewportSize({ width: 390, height: 844 });

    await openAgentRoute(page, workspace);
    await waitForQuestionPrompt(page, 120_000);
    await chooseQuestionOption(page, "App");
    await expect(page.getByTestId("question-form-send-partial")).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("question-box-desktop.png") });

    await workspace.client.waitForAgentUpsert(
      workspace.agentId,
      (snapshot) =>
        ((snapshot as PendingPermissions).pendingPermissions ?? []).some(
          (permission) => (permission.draftAnswers?.answers["0"]?.selected.length ?? 0) > 0,
        ),
      30_000,
    );

    await openAgentRoute(phone, workspace);
    await waitForQuestionPrompt(phone, 60_000);
    await expectQuestionOptionSelected(phone, "App");
    await phone.screenshot({ path: test.info().outputPath("question-box-phone.png") });

    await phone.getByTestId("question-form-send-partial").click();
    await expect(phone.getByTestId("question-form-card")).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByTestId("question-form-card")).toHaveCount(0, { timeout: 30_000 });
    await phone.screenshot({ path: test.info().outputPath("question-box-phone-after.png") });
  } finally {
    await phone.close();
    await workspace.cleanup();
  }
});
