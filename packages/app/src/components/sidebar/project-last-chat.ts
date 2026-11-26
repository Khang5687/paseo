/** A workspace by identity. The project strip remembers one per project. */
export interface ProjectLastChat {
  serverId: string;
  workspaceId: string;
}

interface ProjectWorkspaces {
  viewKey: string;
  workspaces: readonly ProjectLastChat[];
}

function sameWorkspace(a: ProjectLastChat, b: ProjectLastChat): boolean {
  return a.serverId === b.serverId && a.workspaceId === b.workspaceId;
}

/** The project that holds the workspace, or null while no loaded project lists it. */
export function findProjectForWorkspace(
  projects: readonly ProjectWorkspaces[],
  workspace: ProjectLastChat,
): string | null {
  for (const project of projects) {
    if (project.workspaces.some((candidate) => sameWorkspace(candidate, workspace))) {
      return project.viewKey;
    }
  }
  return null;
}

/**
 * The remembered workspace, while the project still lists it. A workspace that was archived or
 * moved out of the project is no longer a place to go back to.
 */
export function resolveProjectLastChat(
  project: ProjectWorkspaces,
  remembered: ProjectLastChat | undefined,
): ProjectLastChat | null {
  if (!remembered) return null;
  return project.workspaces.some((workspace) => sameWorkspace(workspace, remembered))
    ? { serverId: remembered.serverId, workspaceId: remembered.workspaceId }
    : null;
}
