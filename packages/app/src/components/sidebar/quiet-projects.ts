import type { ProjectActivity } from "@/hooks/sidebar-workspaces-view-model";

/** A project with no chat activity for this long folds into "More". */
export const QUIET_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

export function isProjectQuiet(activity: ProjectActivity, now: number): boolean {
  if (activity.needsInput || activity.lastActivityMs === null) return false;
  return now - activity.lastActivityMs >= QUIET_AFTER_MS;
}

/**
 * The projects that fold into "More", in input order. A snoozed project always folds, whatever
 * `keep` says: the user put it away. The rest fold by age: `keep` holds projects that stay out
 * whatever their age (the open chat's project, a filtered-to project, one with a pinned chat).
 * A project with no known activity stays: unknown is not quiet. When every awake project would
 * fold by age, none does, so the sidebar never turns into a lone "More".
 */
export function resolveQuietProjectKeys<T extends { viewKey: string }>(input: {
  projects: readonly T[];
  activityOf: (project: T) => ProjectActivity;
  keep: ReadonlySet<string>;
  now: number;
  snoozed?: ReadonlySet<string>;
}): string[] {
  const snoozed = input.snoozed ?? new Set<string>();
  const awake = input.projects.filter((project) => !snoozed.has(project.viewKey));
  const aged = new Set(
    awake
      .filter(
        (project) =>
          !input.keep.has(project.viewKey) && isProjectQuiet(input.activityOf(project), input.now),
      )
      .map((project) => project.viewKey),
  );
  const foldAged = aged.size < awake.length;
  return input.projects
    .filter((project) => snoozed.has(project.viewKey) || (foldAged && aged.has(project.viewKey)))
    .map((project) => project.viewKey);
}

/**
 * Projects that never fold: those holding one of `workspaceKeys` (the open chat, pinned chats)
 * and those named in `projectKeys` (the project filter).
 */
export function resolveQuietKeep(input: {
  projects: readonly { viewKey: string; workspaces: readonly { workspaceKey: string }[] }[];
  workspaceKeys: readonly string[];
  projectKeys: readonly string[];
}): Set<string> {
  const keep = new Set(input.projectKeys);
  const workspaceKeys = new Set(input.workspaceKeys);
  for (const project of input.projects) {
    if (project.workspaces.some((workspace) => workspaceKeys.has(workspace.workspaceKey))) {
      keep.add(project.viewKey);
    }
  }
  return keep;
}

/** Splits projects into the ones that show and the ones folded into "More", keeping order. */
export function splitQuietProjects<T extends { viewKey: string }>(
  projects: readonly T[],
  quietKeys: ReadonlySet<string>,
): { active: T[]; quiet: T[] } {
  const active: T[] = [];
  const quiet: T[] = [];
  for (const project of projects) {
    (quietKeys.has(project.viewKey) ? quiet : active).push(project);
  }
  return { active, quiet };
}
