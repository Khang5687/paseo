import { generateMessageId } from "@/types/stream";

export const NEW_WORKSPACE_DRAFT_KEY = "new-workspace";
const NEW_WORKSPACE_FORK_DRAFT_PREFIX = `${NEW_WORKSPACE_DRAFT_KEY}:draft:`;
const NEW_WORKSPACE_PROJECT_DRAFT_PREFIX = `${NEW_WORKSPACE_DRAFT_KEY}:project:`;

export function generateDraftId(): string {
  return `draft_${generateMessageId()}`;
}

// The draft belongs to the project the screen was opened for (the sidebar "+",
// the project's "New workspace" row, the shortcut from an active workspace), so
// each project keeps its own unsent prompt. Changing project or host inside the
// screen only retargets the submission; the key stays with the entry project.
export function buildNewWorkspaceDraftKey(input: {
  draftId?: string;
  serverId?: string;
  sourceDirectory?: string;
  projectId?: string;
}): string {
  const explicitDraftId = input.draftId?.trim();
  if (explicitDraftId) {
    return `${NEW_WORKSPACE_FORK_DRAFT_PREFIX}${explicitDraftId}`;
  }
  const serverId = input.serverId?.trim();
  const projectRef = input.sourceDirectory?.trim() || input.projectId?.trim();
  if (serverId && projectRef) {
    return `${NEW_WORKSPACE_PROJECT_DRAFT_PREFIX}${serverId}\u0000${projectRef}`;
  }
  return NEW_WORKSPACE_DRAFT_KEY;
}

export function isLegacyNewWorkspaceDraftKey(draftKey: string): boolean {
  return (
    draftKey.startsWith(`${NEW_WORKSPACE_DRAFT_KEY}:`) &&
    !draftKey.startsWith(NEW_WORKSPACE_FORK_DRAFT_PREFIX) &&
    !draftKey.startsWith(NEW_WORKSPACE_PROJECT_DRAFT_PREFIX)
  );
}

export function buildDraftStoreKey(input: {
  serverId: string;
  agentId: string;
  draftId?: string | null;
}): string {
  const serverId = input.serverId.trim();
  const explicitDraftId = input.draftId?.trim();
  if (explicitDraftId) {
    return `draft:${serverId}:${explicitDraftId}`;
  }
  return `agent:${serverId}:${input.agentId.trim()}`;
}
