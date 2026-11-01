import { expect, test } from "../support/fixtures";
import { expectComposerVisible } from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

// Fork #37: in the provider sheet a long model label and id must truncate, never push the
// enable switch out of its row or off the shared trailing rail.
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test("every model switch on a phone sits fully on screen on one trailing rail", async ({
  page,
}) => {
  const session = await seedMockAgentWorkspace({
    repoPrefix: "provider-model-toggles-",
    title: "Provider model toggles",
  });
  try {
    await openAgentRoute(page, session);
    await expectComposerVisible(page);
    const selectModel = page.getByRole("button", { name: /Select model/ });
    await expect(selectModel).toBeVisible({ timeout: 30_000 });
    await selectModel.tap();
    await expect(page.getByTestId("agent-controls-model-sheet")).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("agent-controls-model").tap();
    await expect(page.getByTestId("agent-controls-model-browser-sheet")).toBeVisible({
      timeout: 10_000,
    });
    await page.getByRole("button", { name: /Open .* settings/ }).tap();
    await expect(page.getByTestId("provider-settings-sheet")).toBeVisible({ timeout: 10_000 });

    // The mock provider lists "Max-only thinking stream" / max-only-thinking-stream, whose label
    // plus id is wider than a phone row. The sheet renders every row, so off-screen rows measure.
    await expect(
      page.getByRole("switch", { name: "Enable Max-only thinking stream" }),
    ).toBeAttached({ timeout: 10_000 });
    const rails = await page.getByRole("switch", { name: /^Enable / }).evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          model: element.getAttribute("aria-label"),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
        };
      }),
    );
    expect(rails.length).toBe(6);
    const [first] = rails;
    expect(first.right).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
    expect(rails).toEqual(
      rails.map(({ model }) => ({ model, right: first.right, width: first.width })),
    );
  } finally {
    await session.cleanup();
  }
});
