# Skins

A skin is background art drawn behind the app shell. Users pick one in **Settings → Appearance →
Background**, import their own image, or install one from a plugin (`client.addSkin`, see
[plugins.md](plugins.md#contribute-a-skin)). Code lives in `packages/app/src/skins/`; the gallery
lives in `packages/app/src/screens/settings/appearance/background/`.

## Layers

`SkinBackdrop` is the first child of `AppContainer`'s surface in `app/_layout.tsx`. Everything the
user reads sits above it. Bottom to top:

1. The root fill: opaque `surface0`.
2. The art. Its opacity follows the route (`home`, `workspace`, `utility`) and crossfades.
3. One scrim in `canvasScrim`: `surface0` at the alpha the contrast gate picks.
4. The app. Page backgrounds use **canvas tokens** (`canvas`, `canvasSidebar`, `canvasWorkspace`).
   They equal `surface0`, `surfaceSidebar`, and `surfaceWorkspace` until a skin is active, then
   turn `transparent` for every area the user shows art behind.

Page backgrounds nest: stack screen, screen root, pane, panel. Translucent page tokens would
compound into an opaque stack, so readability comes from the single scrim and nested pages are
clear. `ThemedStack` also gives React Navigation a transparent `colors.background`, because the
navigator paints its own container under every screen.

- Use a canvas token only for a page background: a screen, pane, sidebar, or header root that art
  may show through.
- Keep `surface0` and the other surface tokens on everything that must stay opaque: menus,
  popovers, sheets, toasts, the composer box, cards, terminals, editors, diff canvases, status
  rings, overlays that cover other content, and fades. Several call sites append alpha hex to
  surface tokens or use them as text colors, so those tokens never carry alpha.

Skin parameters such as the image, blur, and visibility live in the skins store, not in the
Unistyles theme. `AppearanceStyleBoundary` remounts screens when its key tokens change, so a value
that changes while previewing or dragging a control must not be in that key. Only the canvas
tokens change, through `skins/apply-surfaces.ts`, which patches every registered theme the way
`appearance/apply.ts` does.

## Contrast gate

Paseo sizes the scrim, so a skin cannot make text unreadable. `skins/contrast.ts` finds the
smallest scrim alpha at which `foregroundMuted` keeps 4.5:1 over `surface0` (7:1 when the OS asks
for more contrast). It measures against the worst pixel of the art: the brightest 1% on dark themes
and the darkest 1% on light themes. Pure white or pure black is assumed when the image was not
measured. Blending is gamma-encoded sRGB, which is how Chromium composites; a linear-light model
would let too much art through.

The user's **Art visibility** control only moves toward opaque from that floor. Measured luminance
matters: web clients and plugins that ship `luminance` let much more art show than the unmeasured
worst case. Dark art under a light theme (or bright art under a dark theme) gets a near-opaque
scrim, which is why the gallery can apply a skin to the light or dark scheme separately.

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
