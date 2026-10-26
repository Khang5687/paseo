import type { Locator } from "@playwright/test";
import { expect, test, type Page } from "../support/fixtures";
import { contrastRatio, parseColor, type Rgb } from "@/skins/contrast";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

const SETTINGS_KEY = "@paseo:app-settings";
// A uniform mid-grey image, so every pixel of the art behind any text has this color. The gate
// models art by luminance alone, which is exact for grey; a saturated color of the same
// luminance blends a little darker and lands just under the target.
const ART_COLOR = { r: 128, g: 128, b: 128 };
// The app's contrast gate: body text keeps 4.5:1, muted text 3:1 (`skins/contrast.ts`).
const BODY_TEXT_CONTRAST = 4.5;
const MUTED_TEXT_CONTRAST = 3;
// Art drawn below this opacity is not a background the user can see.
const MIN_VISIBLE_ART_OPACITY = 0.1;

interface TextBackdropProbe {
  text: string;
  /** Opaque fill under the art: the shell's `surface0`. */
  base: string;
  /** Composite opacity of the full-viewport skin image. */
  artOpacity: number;
  /** Backgrounds between the art and the text, outermost first. */
  layers: string[];
}

async function artPng(page: Page): Promise<Buffer> {
  const dataUrl = await page.evaluate(({ r, g, b }) => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("no 2d canvas");
    context.fillStyle = `rgb(${r}, ${g}, ${b})`;
    context.fillRect(0, 0, 64, 64);
    return canvas.toDataURL("image/png");
  }, ART_COLOR);
  return Buffer.from(dataUrl.split(",")[1], "base64");
}

async function importSkinForBothThemes(page: Page): Promise<void> {
  await page.goto("/settings");
  const sidebar = page.getByTestId("settings-sidebar");
  await expect(sidebar).toBeVisible({ timeout: 60_000 });
  await sidebar.getByRole("button", { name: "Appearance", exact: true }).tap();

  await expect(page.getByTestId("settings-background-target")).toBeVisible();
  const png = await artPng(page);
  const chooser = page.waitForEvent("filechooser", { timeout: 10_000 });
  await page.getByTestId("settings-background-add").tap();
  await (await chooser).setFiles({ name: "harbor.png", mimeType: "image/png", buffer: png });
  await expect(page.getByTestId("settings-background-undo")).toBeVisible({ timeout: 15_000 });
}

/**
 * Reads what sits behind `target`: the skin image the shell draws, every background painted
 * between that image and the text, and the opaque fill under the image.
 */
async function probeTextBackdrop(target: Locator): Promise<TextBackdropProbe> {
  return target.evaluate((textElement: Element) => {
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const art = Array.from(document.querySelectorAll<HTMLImageElement>('img[src^="blob:"]')).find(
      (image) => {
        const box = image.getBoundingClientRect();
        return box.width >= viewportWidth && box.height >= viewportHeight;
      },
    );
    if (!art) throw new Error("no skin art is drawn behind the app");

    let artOpacity = 1;
    for (let node: Element | null = art; node; node = node.parentElement) {
      artOpacity *= Number(getComputedStyle(node).opacity);
    }

    let shared: Element | null = art.parentElement;
    while (shared && !shared.contains(textElement)) shared = shared.parentElement;
    if (!shared) throw new Error("the art and the text share no ancestor");

    const layers: string[] = [];
    for (
      let node: Element | null = textElement;
      node && node !== shared;
      node = node.parentElement
    ) {
      const background = getComputedStyle(node).backgroundColor;
      if (background !== "rgba(0, 0, 0, 0)" && background !== "transparent") {
        layers.unshift(background);
      }
    }

    let base: string | null = null;
    for (let node: Element | null = shared; node && !base; node = node.parentElement) {
      const background = getComputedStyle(node).backgroundColor;
      if (background.startsWith("rgb(")) base = background;
    }
    if (!base) throw new Error("no opaque fill under the art");

    return { text: getComputedStyle(textElement).color, base, artOpacity, layers };
  });
}

function over(base: Rgb, top: Rgb, alpha: number): Rgb {
  return {
    r: base.r + (top.r - base.r) * alpha,
    g: base.g + (top.g - base.g) * alpha,
    b: base.b + (top.b - base.b) * alpha,
  };
}

function seenBehindText(probe: TextBackdropProbe): Rgb {
  let color: Rgb = parseColor(probe.base);
  color = over(color, ART_COLOR, probe.artOpacity);
  for (const layer of probe.layers) {
    const parsed = parseColor(layer);
    color = over(color, parsed, parsed.a);
  }
  return color;
}

/**
 * `onArt` text sits on a page background, which must let the art through. Other text sits on
 * an opaque card by design; it only has to stay readable on it.
 */
async function expectReadableText(
  target: Locator,
  minimumContrast: number,
  options: { onArt: boolean },
): Promise<void> {
  await expect(target).toBeVisible();
  // The art fades in; wait until it stops changing before reading it.
  let previous = -1;
  await expect
    .poll(async () => {
      const { artOpacity } = await probeTextBackdrop(target);
      const settled = artOpacity === previous && artOpacity >= MIN_VISIBLE_ART_OPACITY;
      previous = artOpacity;
      return settled;
    })
    .toBe(true);

  const probe = await probeTextBackdrop(target);
  if (options.onArt) {
    // Every page background between the art and the text is see-through.
    const opaqueLayers = probe.layers.filter((layer) => parseColor(layer).a >= 0.99);
    expect(opaqueLayers, JSON.stringify(probe)).toEqual([]);
  }

  const text = parseColor(probe.text);
  const background = seenBehindText(probe);
  expect(
    contrastRatio(over(background, text, text.a), background),
    JSON.stringify(probe),
  ).toBeGreaterThanOrEqual(minimumContrast);
}

function visibleText(scope: Page | Locator, text: string): Locator {
  return scope.getByText(text, { exact: true }).filter({ visible: true }).first();
}

async function expectSkinVisibleAcrossSettings(page: Page): Promise<void> {
  // The Appearance page: its title and muted section headings sit on the stack screen the skin
  // must show through.
  await expectReadableText(visibleText(page, "Appearance"), BODY_TEXT_CONTRAST, { onArt: true });
  await expectReadableText(visibleText(page, "Background"), MUTED_TEXT_CONTRAST, { onArt: true });

  // The settings list: its title sits on the root stack screen; the section rows sit on opaque
  // cards.
  await page.goBack();
  const sidebar = page.getByTestId("settings-sidebar");
  await expect(sidebar).toBeVisible();
  await expectReadableText(visibleText(page, "Settings"), BODY_TEXT_CONTRAST, { onArt: true });
  await expectReadableText(visibleText(sidebar, "General"), BODY_TEXT_CONTRAST, { onArt: false });
}

for (const theme of ["light", "dark"] as const) {
  test(`a background skin shows behind settings with readable text in the ${theme} theme`, async ({
    page,
  }) => {
    await page.addInitScript(
      ({ key, value }) => localStorage.setItem(key, JSON.stringify({ theme: value })),
      { key: SETTINGS_KEY, value: theme },
    );
    await importSkinForBothThemes(page);
    await expectSkinVisibleAcrossSettings(page);
  });
}
