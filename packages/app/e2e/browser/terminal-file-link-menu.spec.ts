import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import { TerminalE2EHarness } from "../support/helpers/terminal-dsl";
import { getTerminalBufferText } from "../support/helpers/terminal-perf";

// A right click on a file link in a terminal opens the file menu instead of the browser's text
// menu. Desktop only: on a phone a long press in the terminal selects text.
test.use({ viewport: { width: 1280, height: 800 } });

const LINK_TEXT = "src/linked.ts:3";

let harness: TerminalE2EHarness;

test.beforeEach(async () => {
  harness = await TerminalE2EHarness.create({ tempPrefix: "terminal-file-link-menu-" });
});

test.afterEach(async () => {
  await harness.cleanup();
});

// The viewport point at the middle of the first occurrence of `text` in the visible buffer.
async function pointAtTerminalText(page: Page, text: string): Promise<{ x: number; y: number }> {
  const cell = await page.evaluate((needle) => {
    const term = (
      window as Window & {
        __paseoTerminal?: {
          rows: number;
          cols: number;
          buffer: {
            active: {
              viewportY: number;
              getLine(y: number): { translateToString(trim: boolean): string } | undefined;
            };
          };
        };
      }
    ).__paseoTerminal;
    if (!term) return null;
    const { viewportY } = term.buffer.active;
    for (let row = 0; row < term.rows; row += 1) {
      const line = term.buffer.active.getLine(viewportY + row)?.translateToString(true) ?? "";
      const column = line.indexOf(needle);
      if (column >= 0) {
        return { row, column: column + needle.length / 2, rows: term.rows, cols: term.cols };
      }
    }
    return null;
  }, text);
  const screen = await page.locator(".xterm-screen").filter({ visible: true }).boundingBox();
  if (!cell || !screen) throw new Error(`"${text}" is not on the terminal screen`);
  return {
    x: screen.x + ((cell.column + 0.5) * screen.width) / cell.cols,
    y: screen.y + ((cell.row + 0.5) * screen.height) / cell.rows,
  };
}

test("a right click on a terminal file link copies the file's full path", async ({
  context,
  page,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await mkdir(path.join(harness.tempRepo.path, "src"), { recursive: true });
  await writeFile(path.join(harness.tempRepo.path, "src", "linked.ts"), "one\ntwo\nthree\n");
  const terminal = await harness.createTerminal({
    name: "File links",
    command: "bash",
    args: ["--noprofile", "--norc", "-c", `printf 'see ${LINK_TEXT} here\\n'; cat`],
  });
  await harness.openTerminal(page, { terminalId: terminal.id });
  await expect.poll(() => getTerminalBufferText(page)).toContain(LINK_TEXT);

  const point = await pointAtTerminalText(page, LINK_TEXT);
  // On a wide layout the menu is a popover at the pointer.
  const menu = page.getByTestId("file-path-menu");
  // xterm resolves the link on hover, through the daemon, before it reports the hover.
  await expect(async () => {
    await page.mouse.move(point.x - 40, point.y);
    await page.mouse.move(point.x, point.y, { steps: 4 });
    await page.mouse.click(point.x, point.y, { button: "right" });
    await expect(menu).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });

  await menu.getByTestId("file-path-menu-copy-full-path").click();
  const workspaceRoot = await realpath(harness.tempRepo.path);
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(path.join(workspaceRoot, "src", "linked.ts"));
});
