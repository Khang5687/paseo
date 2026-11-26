/**
 * The project strip: one entry per sidebar project, in the sidebar's own project order.
 * Picking an entry narrows the sidebar to that project through the project filter;
 * "All" clears it. Its position is also the project's number for the jump keys.
 */

/** With one project there is nothing to switch between, so the strip stays out of the way. */
const PROJECT_STRIP_MIN_PROJECTS = 2;

/** The digit keys reach 1-9. */
const PROJECT_STRIP_SHORTCUT_LIMIT = 9;

export function shouldShowProjectStrip(projectCount: number): boolean {
  return projectCount >= PROJECT_STRIP_MIN_PROJECTS;
}

/** The projects the digit keys reach, by strip position. Empty while the strip is hidden. */
export function resolveProjectStripShortcutKeys(projectKeys: readonly string[]): string[] {
  if (!shouldShowProjectStrip(projectKeys.length)) return [];
  return projectKeys.slice(0, PROJECT_STRIP_SHORTCUT_LIMIT);
}

/** The digit that jumps to the entry at `index`, or null past the ninth. */
export function projectStripShortcutNumber(index: number): number | null {
  return index < PROJECT_STRIP_SHORTCUT_LIMIT ? index + 1 : null;
}

export type ProjectStripMove = "first" | "earlier" | "later";

/** The moves that would change anything for this entry, in menu order. */
export function listProjectStripMoves(input: {
  projectKeys: readonly string[];
  viewKey: string;
}): ProjectStripMove[] {
  const index = input.projectKeys.indexOf(input.viewKey);
  if (index === -1) return [];
  const moves: ProjectStripMove[] = [];
  if (index > 1) moves.push("first");
  if (index > 0) moves.push("earlier");
  if (index < input.projectKeys.length - 1) moves.push("later");
  return moves;
}

/** The strip order after one menu move: the touch path for reordering, beside dragging. */
export function moveProjectStripEntry(input: {
  projectKeys: readonly string[];
  viewKey: string;
  move: ProjectStripMove;
}): string[] {
  const keys = [...input.projectKeys];
  const index = keys.indexOf(input.viewKey);
  if (index === -1) return keys;
  const targetByMove: Record<ProjectStripMove, number> = {
    first: 0,
    earlier: Math.max(0, index - 1),
    later: Math.min(keys.length - 1, index + 1),
  };
  const target = targetByMove[input.move];
  keys.splice(index, 1);
  keys.splice(target, 0, input.viewKey);
  return keys;
}
