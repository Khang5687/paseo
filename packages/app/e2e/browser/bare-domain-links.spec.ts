import { expect, test } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

test("bare web address opens on tap at phone width; host-led path is plain text", async ({
  page,
  context,
}) => {
  const session = await seedMockAgentWorkspace({
    repoPrefix: "bare-domain-links-",
    title: "Bare domain links",
    initialPrompt: "Where is the repo?",
    featureValues: {
      mockAssistantResponse:
        "**Repo:** github.com/Khang5687/throwback32 (private)\n\nBuilt from v1.2/build/out with Node.js/Bun/Deno.",
    },
  });
  try {
    await session.client.waitForFinish(session.agentId, 30_000);
    await openAgentRoute(page, session);
    const message = page.getByTestId("assistant-message");
    const link = message.getByRole("link", {
      name: "github.com/Khang5687/throwback32",
      exact: true,
    });
    await expect(link).toBeVisible();
    await expect(message.getByRole("link", { name: "v1.2/build/out", exact: true })).toHaveCount(0);
    await expect(message.getByRole("link", { name: "Node.js/Bun/Deno", exact: true })).toHaveCount(
      0,
    );
    await page.screenshot({ path: test.info().outputPath("bare-domain-link.png") });
    const popup = context.waitForEvent("page");
    await link.tap();
    await expect
      .poll(async () => (await popup).url())
      .toBe("https://github.com/Khang5687/throwback32");
  } finally {
    await session.cleanup();
  }
});
