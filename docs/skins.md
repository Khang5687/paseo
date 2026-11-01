# Skins

A skin is background art drawn behind the app shell. Users pick one in **Settings → Appearance →
Background**, import their own image, or install one from a plugin (`client.addSkin`, see
[plugins.md](plugins.md#contribute-a-skin)). Code lives in `packages/app/src/skins/`; the gallery
lives in `packages/app/src/screens/settings/appearance/background/`.

## Layers

`SkinBackdrop` is the first child of `AppContainer`'s surface in `app/_layout.tsx`. Everything the
user reads sits above it. Bottom to top:

1. The root fill: opaque `surface0`.
2. The art, at one opacity: `min(skin intensity for the route, contrast limit × Art visibility)`.
   Art at opacity `o` over `surface0` is the same picture as a `surface0` scrim at `1 - o` over
   the art, so there is no separate scrim layer and the dimming is applied once. Catalog skins
   ship route intensities (home, workspace, utility) that were designed as the only dimming;
   multiplying them by a scrim hid workspace art almost completely.
3. The app. Page backgrounds use **canvas tokens** (`canvas`, `canvasSidebar`, `canvasWorkspace`).
   They equal `surface0`, `surfaceSidebar`, and `surfaceWorkspace` until a skin is drawn, then
   turn `transparent` for every area the user shows art behind.

Page backgrounds nest: stack screen, screen root, pane, panel. Translucent page tokens would
compound into an opaque stack, so nested pages are clear and the art's own opacity carries the
contrast. `ThemedStack` also gives React Navigation a transparent `colors.background`, because the
navigator paints its own container under every screen.

- Use a canvas token only for a page background: a screen, pane, sidebar, or header root that art
  may show through.
- Keep `surface0` and the other surface tokens on everything that must stay opaque: menus,
  popovers, sheets, toasts, the composer box, cards, terminals, editors, diff canvases, status
  rings, overlays that cover other content, and fades. Several call sites append alpha hex to
  surface tokens or use them as text colors, so those tokens never carry alpha.

Skin parameters such as the image, blur, and visibility live in the skins store, not in the
Unistyles theme. `AppearanceStyleBoundary` remounts screens when its key tokens change, so a value
that changes while previewing or dragging a control must not be in that key. The canvas tokens
change only when a skin starts or stops being drawn, through `skins/apply-surfaces.ts`, which
patches every registered theme the way `appearance/apply.ts` does.

## Contrast limit

Paseo caps the art's opacity, so a skin cannot make text unreadable. `computeArtLimit` in
`skins/contrast.ts` finds the largest opacity at which `foreground` keeps 4.5:1 and
`foregroundMuted` keeps 3:1 against `surface0` blended with the worst pixel of the art (7:1 and
4.5:1 when the OS asks for more contrast). The worst pixel is the brightest 1% on dark themes and
the darkest 1% on light themes; pure white or pure black is assumed when the image was not
measured. Blending is gamma-encoded sRGB, which is how Chromium composites; a linear-light model
would let too much art through.

Muted text sits at the 3:1 tier on purpose. Paseo's light muted grey is only 4.83:1 on plain
white, so holding it at 4.5:1 over art left 3–5% of any image visible in light themes. Users who
need more get it from the OS More Contrast setting.

The user's **Art visibility** control scales the limit down, never past it. Measured luminance
matters: web clients and plugins that ship `luminance` let much more art show than the unmeasured
worst case.

## Cache and offline

Plugin skins exist only while their host is connected, but the selected skin must render at
startup and while the host is offline. The first time a skin is selected, its image is copied into
a device cache as two variants: `display` (long side ≤ 2560 px) and `small` (≤ 640 px, used for blur
and thumbnails). The cache is IndexedDB with `blob:` URLs on web and Electron, and files under the
document directory on native. When a connected plugin contributes a new `version` of a selected
skin, the backdrop re-fetches it. The selection is per device and per color scheme.

`skins/plugin-cache.ts` implements `client.applySkin` and must not import the plugin registry:
`plugins/evaluate.ts` imports it, and the registry imports `evaluate.ts`.

Blur renders the `small` variant with `blurRadius`. It does not use `backdrop-filter`: live
backdrop blur behind scrolling content costs GPU readback on every frame and lags with hardware
acceleration off.

## Accessibility

| Signal                                | Effect                      |
| ------------------------------------- | --------------------------- |
| Reduce transparency                   | Art hidden, canvases opaque |
| Forced colors (Windows high contrast) | Art hidden, canvases opaque |
| More contrast                         | Gate target 7:1             |
| Reduce motion                         | No crossfades               |

Android has no reduce-transparency signal in React Native.

## QA

Check home, a workspace, settings, sessions, and schedules under a light and a dark theme, at
desktop and 390 px widths, with a bright skin and with Reduce transparency on. Cold start with the
plugin host offline must still draw the selected skin.
