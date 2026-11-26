import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "../support/fixtures";
import type { Page } from "@playwright/test";
import { openSettingsSection } from "../support/helpers/settings";
import { openFileExplorer } from "../support/helpers/file-explorer";
import { gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";

// Settings > Files > "Ask where to save" is on by default. A browser decides where downloads go,
// so there the switch is disabled and says so; the desktop and phone builds act on it.
test.use({ hasTouch: true });

test("Settings > Files shows Ask where to save on, and a browser says it does nothing", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings/files");

  const section = page.getByTestId("save-location-settings");
  await expect(section).toBeVisible({ timeout: 30_000 });
  const ask = page.getByTestId("save-location-ask");
  await expect(ask.getByText("Ask where to save")).toBeVisible();
  await expect(ask.getByRole("switch")).toBeChecked();
  await expect(ask.getByRole("switch")).toBeDisabled();
  await expect(ask.getByText("Your browser decides where downloads go")).toBeVisible();
  await expect(section).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath("save-location-setting.png") });
});

type SaveReply = { status: "cancelled" } | { status: "saved"; path: string; folderLabel: string };
interface SaveProbe {
  saves: Array<{ fileName: string; ask: boolean; bytes: number[] }>;
  reveals: string[];
}

function readProbe(page: Page) {
  return page.evaluate(() => ({
    saves: JSON.parse(localStorage.getItem("probe:saves") ?? "[]") as SaveProbe["saves"],
    reveals: JSON.parse(localStorage.getItem("probe:reveals") ?? "[]") as string[],
  }));
}

function explorerEntry(page: Page, name: string) {
  return page.getByTestId("file-explorer-tree-scroll").getByText(name, { exact: true }).first();
}

async function downloadFromExplorer(page: Page, name: string) {
  await explorerEntry(page, name).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Download", exact: true }).click();
}

// Poses as the desktop app: Download hands the bytes to the shell's `files.save` with the
// setting's value, and the toast names the folder and offers Show in folder. The Save dialog and
// the file write are the shell's job (packages/desktop/src/features/file-save.test.ts).
test.describe("Download in the desktop app", () => {
  let workspace: SeededWorkspace;

  test.beforeEach(async () => {
    workspace = await seedWorkspace({ repoPrefix: "save-location-" });
  });

  test.afterEach(async () => {
    await workspace?.cleanup();
  });

  test("asks by default, saves straight to Downloads › Paseo when asking is off", async ({
    page,
  }) => {
    // The probe lives in localStorage so it survives the reload that opens the workspace.
    await page.addInitScript(() => {
      const record = (key: string, entry: unknown) => {
        const entries = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown[];
        localStorage.setItem(key, JSON.stringify([...entries, entry]));
      };
      (window as unknown as { paseoDesktop: unknown }).paseoDesktop = {
        platform: "linux",
        invoke: async () => null,
        getPendingOpenProject: async () => null,
        events: { on: async () => () => undefined },
        files: {
          save: async (input: { fileName: string; ask: boolean; bytes: Uint8Array }) => {
            record("probe:saves", {
              fileName: input.fileName,
              ask: input.ask,
              bytes: Array.from(input.bytes),
            });
            return JSON.parse(localStorage.getItem("probe:reply") ?? '{"status":"cancelled"}');
          },
          reveal: async (target: string) => {
            record("probe:reveals", target);
          },
        },
      };
    });
    const fileName = "rapport données.bin";
    const source = Buffer.from([0, 1, 2, 127, 128, 255, 10]);
    await writeFile(join(workspace.workspaceDirectory, fileName), source);
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoWorkspace(page, workspace.workspaceId);
    await openFileExplorer(page);

    // Asking is on: the shell gets ask=true. The owner backs out of the dialog, so no toast.
    await downloadFromExplorer(page, fileName);
    await expect.poll(async () => (await readProbe(page)).saves.length).toBe(1);
    await expect(page.getByTestId("download-toast-reveal")).toHaveCount(0);

    // Turn asking off in Settings > Files, then download again.
    await page.locator('[data-testid="sidebar-settings"]:visible').first().click();
    await openSettingsSection(page, "chat");
    const askSwitch = page.getByTestId("save-location-ask").getByRole("switch");
    await expect(askSwitch).toBeChecked({ timeout: 30_000 });
    await askSwitch.click();
    await expect(askSwitch).not.toBeChecked();
    await expect(
      page.getByTestId("save-location-ask").getByText("Turn off to save straight to Downloads"),
    ).toBeVisible();

    const savedPath = "/home/me/Downloads/Paseo/rapport données.bin";
    await page.evaluate((reply) => localStorage.setItem("probe:reply", JSON.stringify(reply)), {
      status: "saved",
      path: savedPath,
      folderLabel: "Downloads › Paseo",
    } satisfies SaveReply);
    await gotoWorkspace(page, workspace.workspaceId);
    await openFileExplorer(page);
    await downloadFromExplorer(page, fileName);

    await expect(page.getByText("Saved to Downloads › Paseo")).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("download-saved-toast.png") });
    await page.getByTestId("download-toast-reveal").click();
    await expect.poll(async () => (await readProbe(page)).reveals).toEqual([savedPath]);
    const { saves } = await readProbe(page);
    expect(saves.map(({ fileName: name, ask }) => ({ name, ask }))).toEqual([
      { name: fileName, ask: true },
      { name: fileName, ask: false },
    ]);
    expect(saves[1]?.bytes).toEqual([...source]);
  });
});
