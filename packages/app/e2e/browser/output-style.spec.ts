import { expect, type Page } from "@playwright/test";
import { test } from "../support/fixtures";
import { seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { startForkAgentUiDaemon, type ForkAgentUiDaemon } from "./fork-agent-ui-daemon";

// Guards fork #28 (per-provider Style default in the provider sheet) and #52 (daemon-wide
// default output style in host Agents settings): the picked style is what a new agent starts with.
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

async function pickStyle(page: Page, prefix: string, styleId: string, styleLabel: string) {
  const trigger = page.getByTestId(`${prefix}-trigger-output_style`);
  await expect(trigger).toBeEnabled({ timeout: 30_000 });
  await trigger.tap();
  await page.getByTestId(`${prefix}-option-output_style-${styleId}`).tap();
  await expect(trigger).toContainText(styleLabel, { timeout: 15_000 });
}

async function expectNewAgentStyle(daemon: ForkAgentUiDaemon, styleId: string) {
  const before = daemon.createdFeatureValues.length;
  const session = await seedMockAgentWorkspace({
    port: daemon.port,
    repoPrefix: "output-style-",
    title: "Output style e2e",
  });
  try {
    await expect.poll(() => daemon.createdFeatureValues.length).toBeGreaterThan(before);
    expect(daemon.createdFeatureValues.at(-1)).toMatchObject({ output_style: styleId });
  } finally {
    await session.cleanup();
  }
}

test.describe("Output style defaults", () => {
  let daemon: ForkAgentUiDaemon;

  test.beforeEach(async ({ page }) => {
    daemon = await startForkAgentUiDaemon();
    await daemon.registerHost(page);
  });

  test.afterEach(async () => {
    const testInfo = test.info();
    await daemon.stop();
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach("fork-ui-daemon", {
        body: daemon.output.join(""),
        contentType: "text/plain",
      });
    }
  });

  test("the host default style applies to new agents and survives a reload", async ({ page }) => {
    test.setTimeout(180_000);
    const prefix = "host-page-default-output-style";
    await page.goto(`/settings/hosts/${encodeURIComponent(daemon.serverId)}/agents`);
    await pickStyle(page, prefix, "explanatory", "Explanatory");
    await expectNewAgentStyle(daemon, "explanatory");

    await page.reload();
    await expect(page.getByTestId(`${prefix}-trigger-output_style`)).toContainText("Explanatory", {
      timeout: 30_000,
    });
  });

  test("the provider sheet style default applies to new agents", async ({ page }) => {
    test.setTimeout(180_000);
    const prefix = "provider-feature-default";
    await page.goto(`/settings/hosts/${encodeURIComponent(daemon.serverId)}/providers`);
    const mockProvider = page.getByRole("button", { name: "Mock Load Test provider details" });
    await mockProvider.scrollIntoViewIfNeeded();
    await mockProvider.tap();
    await expect(page.getByTestId("provider-feature-defaults")).toBeVisible({ timeout: 30_000 });
    await pickStyle(page, prefix, "learning", "Learning");
    await expectNewAgentStyle(daemon, "learning");
  });
});
