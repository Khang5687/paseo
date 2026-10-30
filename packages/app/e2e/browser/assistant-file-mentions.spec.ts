import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { expectFileTabOpen } from "../support/helpers/file-explorer";
import type { MockAgentWorkspace } from "../support/helpers/mock-agent";

// An agent names files in fences, inline code and prose, with any extension. Each one opens.
const REPLY = [
  "The contract file. If it is not open, here it is:",
  "",
  "```",
  "records/q3/contract.pdf",
  "```",
  "",
  "The export is `data/export.csv`, the notes are in notes/q3/summary.log and the",
  "components live in `src/components/`.",
].join("\n");

const FILES = {
  "records/q3/contract.pdf": "%PDF-1.4\n",
  "data/export.csv": "name,total\nkarl,27\n",
  "notes/q3/summary.log": "summary line\n",
  "src/components/button.tsx": "export {};\n",
};

// Each link opens a tab over the chat; come back to the reply before the next one.
async function openFromReply(page: Page, session: MockAgentWorkspace, name: string) {
  await page.getByTestId(`workspace-tab-agent_${session.agentId}`).first().click();
  await page.getByTestId("assistant-message").getByText(name, { exact: true }).click();
}

test("files named in a fence, inline code and prose open from the reply", async ({ page }) => {
  const session = await seedMockAgentWorkspace({
    repoPrefix: "assistant-file-mentions-",
    title: "File mentions",
    initialPrompt: "Show the files",
    featureValues: { mockAssistantResponse: REPLY },
  });
  try {
    for (const [file, content] of Object.entries(FILES)) {
      await mkdir(path.dirname(path.join(session.cwd, file)), { recursive: true });
      await writeFile(path.join(session.cwd, file), content);
    }
    await session.client.waitForFinish(session.agentId, 30_000);
    await openAgentRoute(page, session);

    await openFromReply(page, session, "records/q3/contract.pdf");
    await expectFileTabOpen(page, "records/q3/contract.pdf");

    await openFromReply(page, session, "data/export.csv");
    await expectFileTabOpen(page, "data/export.csv");

    await openFromReply(page, session, "notes/q3/summary.log");
    await expectFileTabOpen(page, "notes/q3/summary.log");

    await openFromReply(page, session, "src/components/");
    await expect(
      page.getByTestId("file-explorer-tree-scroll").getByText("button.tsx", { exact: true }),
    ).toBeVisible();
  } finally {
    await page.screenshot({ path: test.info().outputPath("file-mentions.png") });
    await session.cleanup();
  }
});
