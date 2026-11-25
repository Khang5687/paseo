import type { SidebarStatusWorkspacePlacement } from "@/hooks/sidebar-workspaces-view-model";

export interface JumpTarget {
  serverId: string;
  workspaceId: string;
}

export const RECENT_WORKSPACES_LIMIT = 20;

function sameTarget(left: JumpTarget, right: JumpTarget): boolean {
  return left.serverId === right.serverId && left.workspaceId === right.workspaceId;
}

/** `recent` with `target` moved to the front, capped. Returns `recent` when it is already first. */
export function pushRecentWorkspace(
  recent: readonly JumpTarget[],
  target: JumpTarget,
  limit: number = RECENT_WORKSPACES_LIMIT,
): readonly JumpTarget[] {
  if (recent[0] && sameTarget(recent[0], target)) return recent;
  const rest = recent.filter((entry) => !sameTarget(entry, target));
  return [{ serverId: target.serverId, workspaceId: target.workspaceId }, ...rest].slice(0, limit);
}

/**
 * The list a recent-workspaces walk steps through: the open workspace first, then the rest of the
 * visit history, skipping workspaces the sidebar does not list right now. A host that has not
 * loaded yet lists nothing, so its entries sit out this walk instead of being forgotten.
 */
export function buildRecentWalk(input: {
  recent: readonly JumpTarget[];
  current: JumpTarget | null;
  isListed: (target: JumpTarget) => boolean;
}): JumpTarget[] {
  const history = input.current ? pushRecentWorkspace(input.recent, input.current) : input.recent;
  return history.filter(
    (entry, index) => (index === 0 && input.current !== null) || input.isListed(entry),
  );
}

export function stepWalkIndex(index: number, delta: 1 | -1, length: number): number {
  return (((index + delta) % length) + length) % length;
}

/** Every workspace waiting on you, the one that has waited longest first. */
export function resolveWaitingWorkspaces(
  entries: Iterable<
    Pick<
      SidebarStatusWorkspacePlacement,
      "serverId" | "workspaceId" | "statusBucket" | "statusEnteredAt"
    >
  >,
): JumpTarget[] {
  const waiting = [...entries].filter((entry) => entry.statusBucket === "needs_input");
  waiting.sort(
    (left, right) =>
      (left.statusEnteredAt?.getTime() ?? Number.MAX_SAFE_INTEGER) -
      (right.statusEnteredAt?.getTime() ?? Number.MAX_SAFE_INTEGER),
  );
  return waiting.map((entry) => ({ serverId: entry.serverId, workspaceId: entry.workspaceId }));
}

/** The waiting workspace after the open one, wrapping; the first one when the open one is not waiting. */
export function nextWaitingWorkspace(
  waiting: readonly JumpTarget[],
  current: JumpTarget | null,
): JumpTarget | null {
  const position = current ? waiting.findIndex((entry) => sameTarget(entry, current)) : -1;
  if (position === -1) return waiting[0] ?? null;
  if (waiting.length === 1) return null;
  return waiting[(position + 1) % waiting.length] ?? null;
}

/** How many waiting workspaces "Next waiting" can still take you to. */
export function countOtherWaiting(waiting: readonly JumpTarget[], current: JumpTarget | null) {
  if (!current) return waiting.length;
  return waiting.filter((entry) => !sameTarget(entry, current)).length;
}
