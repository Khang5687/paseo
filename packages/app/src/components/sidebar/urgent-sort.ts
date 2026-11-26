import type {
  SidebarProjectEntry,
  SidebarStatusWorkspacePlacement,
  SidebarWorkspacePlacement,
} from "@/hooks/sidebar-workspaces-view-model";
import { STATUS_BUCKET_ORDER, type SidebarStateBucket } from "@/utils/sidebar-agent-state";

type StatusLookup = ReadonlyMap<
  string,
  Pick<SidebarStatusWorkspacePlacement, "statusBucket" | "statusEnteredAt">
>;

// STATUS_BUCKET_ORDER is the attention order herdr uses: waiting on you, failed, finished but
// not read yet, working, nothing new.
const RANK_BY_BUCKET = new Map<SidebarStateBucket, number>(
  STATUS_BUCKET_ORDER.map((bucket, index) => [bucket, index]),
);
const UNKNOWN_RANK = STATUS_BUCKET_ORDER.length;

interface RankedWorkspace<T> {
  workspace: T;
  rank: number;
  enteredAt: number | null;
  position: number;
}

function compareRanked<T>(left: RankedWorkspace<T>, right: RankedWorkspace<T>): number {
  if (left.rank !== right.rank) return left.rank - right.rank;
  // Newest change first. A row with no change time keeps its place after the timed ones.
  if (left.enteredAt !== null && right.enteredAt !== null && left.enteredAt !== right.enteredAt) {
    return right.enteredAt - left.enteredAt;
  }
  if (left.enteredAt !== null && right.enteredAt === null) return -1;
  if (left.enteredAt === null && right.enteredAt !== null) return 1;
  return left.position - right.position;
}

/**
 * The project's workspaces, most urgent first, newest status change first inside each status.
 * Rows with the same status and no change time keep the incoming order (last prompt). Returns
 * the input array when nothing moved, so an unchanged project keeps its identity.
 */
export function sortWorkspacesByUrgency<T extends SidebarWorkspacePlacement>(
  workspaces: readonly T[],
  statuses: StatusLookup,
): readonly T[] {
  const ranked = workspaces.map((workspace, position): RankedWorkspace<T> => {
    const status = statuses.get(workspace.workspaceKey);
    return {
      workspace,
      rank: status ? (RANK_BY_BUCKET.get(status.statusBucket) ?? UNKNOWN_RANK) : UNKNOWN_RANK,
      enteredAt: status?.statusEnteredAt?.getTime() ?? null,
      position,
    };
  });
  ranked.sort(compareRanked);
  const moved = ranked.some((entry, index) => entry.position !== index);
  return moved ? ranked.map((entry) => entry.workspace) : workspaces;
}

/** Each project with its workspaces in urgency order; unchanged projects keep their identity. */
export function sortProjectsByUrgency(
  projects: SidebarProjectEntry[],
  statuses: StatusLookup,
): SidebarProjectEntry[] {
  let changed = false;
  const sorted = projects.map((project) => {
    const workspaces = sortWorkspacesByUrgency(project.workspaces, statuses);
    if (workspaces === project.workspaces) return project;
    changed = true;
    return { ...project, workspaces: [...workspaces] };
  });
  return changed ? sorted : projects;
}
