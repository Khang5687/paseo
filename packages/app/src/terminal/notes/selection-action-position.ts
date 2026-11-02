import type { TerminalSelectionAnchor } from "./terminal-note-types";

export interface SelectionActionSize {
  width: number;
  height: number;
}

const GAP = 6;
const EDGE_INSET = 4;

/**
 * Where a floating action sits next to a terminal selection: below its last row, right-aligned
 * with its end, or above its first row when there is no room below. Null while the selection is
 * scrolled out of view.
 */
export function resolveSelectionActionPosition(
  anchor: TerminalSelectionAnchor,
  size: SelectionActionSize,
): { left: number; top: number } | null {
  if (anchor.bottom <= 0 || anchor.top >= anchor.height) return null;
  const below = anchor.bottom + GAP;
  const above = anchor.top - GAP - size.height;
  const top =
    below + size.height <= anchor.height - EDGE_INSET || above < EDGE_INSET
      ? Math.min(below, anchor.height - EDGE_INSET - size.height)
      : above;
  const maxLeft = Math.max(EDGE_INSET, anchor.width - EDGE_INSET - size.width);
  const left = Math.min(Math.max(EDGE_INSET, anchor.right - size.width), maxLeft);
  return { left, top: Math.max(EDGE_INSET, top) };
}
