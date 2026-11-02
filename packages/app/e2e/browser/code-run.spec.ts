import { expect, test, type Page } from "../support/fixtures";
import { composerLocator } from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

const PHONE = { width: 390, height: 844 };
const SECRET = "hunter2-secret";

// Untagged fences mirror what agents write for one-liners; only command-shaped ones get Run.
const ASSISTANT_MARKDOWN = [
  "The script is ready. Run this:",
  "",
  "```",
  'echo "hello from $(basename "$PWD")"',
  "```",
  "",
  "Then the prompt:",
  "",
  "```sh",
  "printf 'Password: '; read -rs secret; echo; echo \"length=${#secret}\"",
  "```",
  "",
  "Confirm it:",
  "",
  "```bash",
  "printf 'Proceed? [y/N] '; read -r answer; echo \"answer=$answer\"",
  "```",
  "",
  "Later, as admin:",
  "",
  "```",
  "sudo bash /tmp/control-room-buttons-tab-apply.sh",
  "```",
  "",
  "```",
  "Done in 3s.",
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

/** Full-page shot with the card centered, so the evidence shows the card in its chat. */
async function shot(page: Page, name: string) {
  await page
    .getByTestId("code-run-card")
    .evaluate((element) => element.scrollIntoView({ block: "center" }));
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
}

test("runs a shell fence from the hover control on desktop", async ({ page }) => {
  const agent = await openSeededChat(page, { width: 1280, height: 900 });
  try {
    await page.getByText('echo "hello from', { exact: false }).first().hover();
    await page.getByTestId("code-block-run").first().click();
    await page.getByTestId("code-run-confirm").click();
    const card = page.getByTestId("code-run-card");
    await expect(card.getByText(/Done · exit 0/)).toBeVisible({ timeout: 20_000 });
    await expect(card.getByTestId("code-run-output")).toContainText("hello from code-run-");
    await shot(page, "code-run-desktop");
  } finally {
    await agent.cleanup();
  }
});

test("runs an untagged one-liner by tap and reattaches after reload", async ({ page }) => {
  const agent = await openSeededChat(page);
  try {
    const runButtons = page.getByTestId("code-block-run");
    // Two untagged commands, sh and bash; the output block and the ts fence get no Run.
    await expect(runButtons).toHaveCount(4);
    await expect(page.getByTestId("code-run-risk")).toHaveText("Runs as admin");
    const firstRun = await runButtons.first().boundingBox();
    expect(firstRun?.height).toBeGreaterThanOrEqual(44);

    await runButtons.first().click();
    const card = page.getByTestId("code-run-card");
    await expect(card.getByTestId("code-run-where")).toContainText("Runs on");
    await expect(card.getByTestId("code-run-command")).toHaveValue(
      'echo "hello from $(basename "$PWD")"',
    );
    await shot(page, "code-run-confirm-390");
    await card.getByTestId("code-run-confirm").click();

    // The run stays open while you watch it finish; its status line folds and unfolds it.
    await expect(card.getByText(/Done · exit 0 · \d+s/)).toBeVisible({ timeout: 20_000 });
    const output = card.getByTestId("code-run-output");
    await expect(output).toContainText("hello from code-run-");
    await expect(output).not.toContainText("paseo-run-");
    await shot(page, "code-run-finished-390");
    await card.getByTestId("code-run-status").click();
    await expect(output).toHaveCount(0);
    await card.getByTestId("code-run-status").click();

    await card.getByTestId("code-run-send").click();
    const composer = composerLocator(page);
    await expect(composer).toHaveValue(/\$ echo "hello from[\s\S]*Exit status 0/);
    await expect(composer).toBeFocused();

    // A success found on return opens folded to its status line.
    await page.reload();
    const reattached = page.getByTestId("code-run-card");
    await expect(reattached.getByText(/Done · exit 0/)).toBeVisible({ timeout: 20_000 });
    await expect(reattached.getByTestId("code-run-output")).toHaveCount(0);
    await reattached.getByTestId("code-run-status").click();
    await expect(reattached.getByTestId("code-run-output")).toContainText("hello from code-run-");
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
    await expect(answer).toBeFocused();
    await expect(card.getByText("Password", { exact: true })).toBeVisible();
    await shot(page, "code-run-password-390");
    await answer.fill(SECRET);
    await answer.press("Enter");

    await expect(card.getByText(/Done · exit 0/)).toBeVisible({ timeout: 20_000 });
    await expect(card.getByTestId("code-run-output")).toContainText(`length=${SECRET.length}`);
    await expect(card).not.toContainText(SECRET);
  } finally {
    await agent.cleanup();
  }
});

test("answers a yes/no prompt with a chip", async ({ page }) => {
  const agent = await openSeededChat(page);
  try {
    await page.getByTestId("code-block-run").nth(2).click();
    await page.getByTestId("code-run-confirm").click();

    const card = page.getByTestId("code-run-card");
    const yes = card.getByTestId("code-run-chip-yes");
    await expect(yes).toBeVisible({ timeout: 20_000 });
    await expect(card.getByTestId("code-run-stop")).toBeVisible();
    await shot(page, "code-run-chips-390");
    await yes.click();

    await expect(card.getByText(/Done · exit 0/)).toBeVisible({ timeout: 20_000 });
    await expect(card.getByTestId("code-run-output")).toContainText("answer=y");
  } finally {
    await agent.cleanup();
  }
});
