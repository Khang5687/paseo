import { generateMessageId } from "@/types/stream";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";

export const NEW_WORKSPACE_DRAFT_KEY = "new-workspace";
const NEW_WORKSPACE_FORK_DRAFT_PREFIX = `${NEW_WORKSPACE_DRAFT_KEY}:draft:`;

export function generateDraftId(): string {
  return `draft_${generateMessageId()}`;
}

export function buildNewWorkspaceDraftKey(draftId?: string): string {
  const explicitDraftId = draftId?.trim();
  if (explicitDraftId) {
    return `${NEW_WORKSPACE_FORK_DRAFT_PREFIX}${explicitDraftId}`;
  }
  return NEW_WORKSPACE_DRAFT_KEY;
}

export function isLegacyNewWorkspaceDraftKey(draftKey: string): boolean {
  return (
    draftKey.startsWith(`${NEW_WORKSPACE_DRAFT_KEY}:`) &&
    !draftKey.startsWith(NEW_WORKSPACE_FORK_DRAFT_PREFIX)
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

/** The composer draft a workspace tab owns, or null for tabs without a composer. */
export function buildTabDraftStoreKey(input: {
  serverId: string;
  tabId: string;
  target: WorkspaceTabTarget;
}): string | null {
  if (input.target.kind === "agent") {
    return buildDraftStoreKey({ serverId: input.serverId, agentId: input.target.agentId });
  }
  if (input.target.kind === "draft") {
    return buildDraftStoreKey({
      serverId: input.serverId,
      agentId: input.tabId,
      draftId: input.target.draftId,
    });
  }
  return null;
}
