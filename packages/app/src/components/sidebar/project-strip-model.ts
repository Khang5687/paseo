/**
 * The project strip: one entry per sidebar project, in the sidebar's own project order.
 * Picking an entry narrows the sidebar to that project through the project filter;
 * "All" clears it. Its position is also the project's number for the jump keys.
 */

import type { ProjectStatusCounts } from "@/hooks/sidebar-workspaces-view-model";

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

export type ProjectStripMove = "top" | "earlier" | "later" | "bottom";

/** The moves that would change anything for this entry, in menu order. */
export function listProjectStripMoves(input: {
  projectKeys: readonly string[];
  viewKey: string;
}): ProjectStripMove[] {
  const index = input.projectKeys.indexOf(input.viewKey);
  if (index === -1) return [];
  const last = input.projectKeys.length - 1;
  const moves: ProjectStripMove[] = [];
  // One step from an end, "earlier" or "later" already reaches it, so the end move would repeat it.
  if (index > 1) moves.push("top");
  if (index > 0) moves.push("earlier");
  if (index < last) moves.push("later");
  if (index < last - 1) moves.push("bottom");
  return moves;
}

/**
 * Move to top and Move to bottom alone, for menus that sit beside a drag (the desktop rail): with
 * no one-step moves there, each end move shows whenever it changes anything.
 */
export function listProjectEndMoves(input: {
  projectKeys: readonly string[];
  viewKey: string;
}): ProjectStripMove[] {
  const index = input.projectKeys.indexOf(input.viewKey);
  if (index === -1) return [];
  const moves: ProjectStripMove[] = [];
  if (index > 0) moves.push("top");
  if (index < input.projectKeys.length - 1) moves.push("bottom");
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
    top: 0,
    earlier: Math.max(0, index - 1),
    later: Math.min(keys.length - 1, index + 1),
    bottom: keys.length - 1,
  };
  const target = targetByMove[input.move];
  keys.splice(index, 1);
  keys.splice(target, 0, input.viewKey);
  return keys;
}

/** A project's chats that get a dot beside its icon. Done chats you already opened get none. */
export type ProjectStatusDot = "needs_input" | "failed" | "attention" | "running";

/** About this many dots fit beside a rail icon. */
const PROJECT_STATUS_DOT_LIMIT = 4;

export interface ProjectStatusDots {
  dots: ProjectStatusDot[];
  /** More chats than dots: a "+" under the last dot. */
  more: boolean;
}

/**
 * One dot per chat, most urgent first: asking you, failed, done and not opened, working. Past the
 * limit the last place goes to a "+", so working chats are the first to lose their dot.
 */
export function listProjectStatusDots(counts: ProjectStatusCounts): ProjectStatusDots {
  const all: ProjectStatusDot[] = [
    ...Array<ProjectStatusDot>(counts.needsInput).fill("needs_input"),
    ...Array<ProjectStatusDot>(counts.failed).fill("failed"),
    ...Array<ProjectStatusDot>(counts.attention).fill("attention"),
    ...Array<ProjectStatusDot>(counts.running).fill("running"),
  ];
  if (all.length <= PROJECT_STATUS_DOT_LIMIT) return { dots: all, more: false };
  return { dots: all.slice(0, PROJECT_STATUS_DOT_LIMIT - 1), more: true };
}
