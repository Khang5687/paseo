import { expect, test, type Page } from "../support/fixtures";
import { composerLocator } from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

const PHONE = { width: 390, height: 844 };
const SECRET = "hunter2-secret";

const ASSISTANT_MARKDOWN = [
  "Check the greeting:",
  "",
  "```bash",
  'echo "hello from $(basename "$PWD")"',
  "```",
  "",
  "Then the prompt:",
  "",
  "```sh",
  "printf 'Password: '; read -rs secret; echo; echo \"length=${#secret}\"",
  "```",
  "",
  "```ts",
  "const notRunnable = true;",
  "```",
].join("\n");

async function openSeededChat(page: Page, viewport = PHONE) {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "code-run-",
    title: "Code run",
    initialPrompt: "Show the commands.",
    featureValues: { mockAssistantResponse: ASSISTANT_MARKDOWN },
  });
  await agent.client.waitForAgentUpsert(
    agent.agentId,
    (snapshot) => snapshot.status === "idle",
    30_000,
  );
  await page.setViewportSize(viewport);
  await openAgentRoute(page, agent);
  return agent;
}

test("runs a shell fence from the hover control on desktop", async ({ page }) => {
  const agent = await openSeededChat(page, { width: 1280, height: 900 });
  try {
    const fence = page.getByText('echo "hello from', { exact: false }).first();
    await fence.hover();
    await page.getByTestId("code-block-run").first().click();
    await page.getByTestId("code-run-confirm").click();
    const card = page.getByTestId("code-run-card");
    await expect(card.getByTestId("code-run-output")).toContainText("hello from code-run-", {
      timeout: 20_000,
    });
    await expect(card.getByText("Exit 0")).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("code-run-desktop.png") });
  } finally {
    await agent.cleanup();
  }
});

test("runs a shell fence by tap and reattaches after reload", async ({ page }) => {
  const agent = await openSeededChat(page);
  try {
    const runButtons = page.getByTestId("code-block-run");
    // Two shell fences; the ts fence gets no Run control.
    await expect(runButtons).toHaveCount(2);

    await runButtons.first().click();
    const card = page.getByTestId("code-run-card");
    await expect(page.getByTestId("code-run-command")).toHaveValue(
      'echo "hello from $(basename "$PWD")"',
    );
    await page.getByTestId("code-run-confirm").click();

    const output = card.getByTestId("code-run-output");
    await expect(output).toContainText("hello from code-run-", { timeout: 20_000 });
    await expect(card.getByText("Exit 0")).toBeVisible();
    // The wrapper the card types never shows up as output.
    await expect(output).not.toContainText("paseo-run-");
    await page.screenshot({ path: test.info().outputPath("code-run-finished-390.png") });

    await card.getByTestId("code-run-send").click();
    await expect(composerLocator(page)).toHaveValue(/\$ echo "hello from[\s\S]*Exit status 0/);

    await page.reload();
    const reattached = page.getByTestId("code-run-card");
    await expect(reattached.getByTestId("code-run-output")).toContainText("hello from code-run-", {
      timeout: 20_000,
    });
    await expect(reattached.getByText("Exit 0")).toBeVisible();
  } finally {
    await agent.cleanup();
  }
});

test("answers a password prompt without showing the secret", async ({ page }) => {
  const agent = await openSeededChat(page);
  try {
    await page.getByTestId("code-block-run").nth(1).click();
    await page.getByTestId("code-run-confirm").click();

    const card = page.getByTestId("code-run-card");
    const answer = card.getByTestId("code-run-answer");
    await expect(answer).toHaveAttribute("type", "password", { timeout: 20_000 });
    await page.screenshot({ path: test.info().outputPath("code-run-password-390.png") });
    await answer.fill(SECRET);
    await answer.press("Enter");

    const output = card.getByTestId("code-run-output");
    await expect(output).toContainText(`length=${SECRET.length}`, { timeout: 20_000 });
    await expect(card.getByText("Exit 0")).toBeVisible();
    await expect(card).not.toContainText(SECRET);
  } finally {
    await agent.cleanup();
  }
});
