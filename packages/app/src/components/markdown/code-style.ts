import type { Theme } from "@/styles/theme";

/** The fence look `HighlightedCodeBlock` takes wherever Markdown renders it. */
export function markdownCodeStyle(theme: Theme) {
  return {
    inheritedStyles: {
      color: theme.colors.foreground,
      fontFamily: theme.fontFamily.mono,
      fontSize: theme.fontSize.code,
    },
    textStyle: { backgroundColor: theme.colors.surface2, padding: 12, borderRadius: 8 },
  };
}
