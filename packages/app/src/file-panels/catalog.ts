import type { FilePanelCandidate } from "./resolve";

/**
 * Media panels read the whole file over the host connection before they play or show it, so a
 * bigger file opens with Download instead.
 */
export const MEDIA_PREVIEW_MAX_BYTES = 100 * 1024 * 1024;

const renderingPanels = [
  {
    id: "builtin:markdown",
    builtin: true,
    files: { extensions: ["md", "markdown"] },
    fileKind: "text",
  },
  {
    id: "builtin:html",
    builtin: true,
    files: { extensions: ["html", "htm"] },
    fileKind: "text",
  },
  {
    id: "builtin:image",
    builtin: true,
    files: { extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg"] },
    fileKind: "image",
  },
  {
    id: "builtin:video",
    builtin: true,
    files: { extensions: ["mp4", "mov", "webm", "m4v"] },
    fileKind: "binary",
    maxBytes: MEDIA_PREVIEW_MAX_BYTES,
  },
  {
    id: "builtin:audio",
    builtin: true,
    files: { extensions: ["mp3", "m4a", "wav", "ogg", "aac", "flac"] },
    fileKind: "binary",
    maxBytes: MEDIA_PREVIEW_MAX_BYTES,
  },
  {
    id: "builtin:pdf",
    builtin: true,
    files: { extensions: ["pdf"] },
    fileKind: "binary",
    maxBytes: MEDIA_PREVIEW_MAX_BYTES,
  },
] as const satisfies readonly FilePanelCandidate[];

/**
 * Paseo's editor, the floor for text files: every text file no other built-in claims has it, so a
 * text file always opens with some panel. A built-in that claims a file owns its source view.
 */
export const sourceFilePanel = {
  id: "builtin:source",
  builtin: true,
  files: "all",
  fileKind: "text",
} as const satisfies FilePanelCandidate;

export type RenderingFilePanel = (typeof renderingPanels)[number];
export type SourceFilePanel = typeof sourceFilePanel;

/**
 * Every panel a host offers, in resolver order: the built-ins that render a file, then plugin
 * panels, then Source. Source is last so a plugin panel is the default over it.
 *
 * `inlinePdf` is false where the device has no PDF viewer to embed (Android's WebView), so a PDF
 * opens with Download there unless a plugin panel claims it.
 */
export function filePanelCatalog<Plugin extends FilePanelCandidate>(
  pluginPanels: readonly Plugin[],
  device: { inlinePdf: boolean } = { inlinePdf: true },
): readonly (RenderingFilePanel | Plugin | SourceFilePanel)[] {
  const builtins = device.inlinePdf
    ? renderingPanels
    : renderingPanels.filter((panel) => panel.id !== "builtin:pdf");
  return [...builtins, ...pluginPanels, sourceFilePanel];
}
