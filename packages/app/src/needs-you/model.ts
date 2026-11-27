import type { AgentOpenQuestion } from "@getpaseo/protocol/messages";
import type { SessionState } from "@/stores/session-store";
import type { PendingPermission } from "@/types/shared";
import { deriveEffectiveWorkspaceStatus } from "@/workspace-status";

/** The parts of a host's session Needs you reads. */
export type NeedsYouSessionInput = Pick<
  SessionState,
  "workspaces" | "workspaceAgentActivity" | "threadAgents" | "agents" | "pendingPermissions"
>;

/** One agent's open ❓ questions inside a waiting chat. */
export interface NeedsYouQuestionGroup {
  agentId: string;
  questions: readonly AgentOpenQuestion[];
}

/** A chat (a sidebar workspace row) that waits on the owner. */
export interface NeedsYouChat {
  key: string;
  serverId: string;
  workspaceId: string;
  projectName: string;
  title: string;
  /** When the chat started waiting, in ms; null when the host did not say. */
  waitingSince: number | null;
  questionGroups: NeedsYouQuestionGroup[];
  permissions: PendingPermission[];
}

function isWaiting(serverId: string, session: NeedsYouSessionInput, workspaceId: string): boolean {
  const workspace = session.workspaces.get(workspaceId);
  if (!workspace || workspace.background || workspace.archivingAt) return false;
  const status = deriveEffectiveWorkspaceStatus({
    serverId,
    workspace,
    workspaceAgentActivity: session.workspaceAgentActivity,
  }).status;
  return status === "needs_input";
}

/** How many chats wait on the owner, across every host. Cheap enough for the rail's number. */
export function countNeedsYouChats(
  sessions: Readonly<Record<string, NeedsYouSessionInput>>,
): number {
  let count = 0;
  for (const [serverId, session] of Object.entries(sessions)) {
    for (const workspaceId of session.workspaces.keys()) {
      if (isWaiting(serverId, session, workspaceId)) count += 1;
    }
  }
  return count;
}

/**
 * Every chat waiting on the owner, on every host, the one that waited longest first (owner
 * decision Q91). A chat waits when its sidebar row is `needs_input`: a pending permission or
 * question box, open ❓ questions, or a reply that ends in a question. Each entry carries the
 * cards it can be answered with; a chat with none is answered in the chat itself.
 */
export function listNeedsYouChats(
  sessions: Readonly<Record<string, NeedsYouSessionInput>>,
): NeedsYouChat[] {
  const chats: NeedsYouChat[] = [];
  for (const [serverId, session] of Object.entries(sessions)) {
    for (const [workspaceId, workspace] of session.workspaces) {
      if (!isWaiting(serverId, session, workspaceId)) continue;
      const agentIds = session.threadAgents.get(workspaceId)?.agentIds ?? [];
      const inChat = new Set(agentIds);
      chats.push({
        key: `${serverId}:${workspaceId}`,
        serverId,
        workspaceId,
        projectName: workspace.projectCustomName ?? workspace.projectDisplayName,
        title: workspace.title ?? workspace.name,
        waitingSince: workspace.statusEnteredAt?.getTime() ?? null,
        questionGroups: agentIds.flatMap((agentId) => {
          const questions = session.agents.get(agentId)?.openQuestions ?? [];
          return questions.length > 0 ? [{ agentId, questions }] : [];
        }),
        permissions: [...session.pendingPermissions.values()].filter((permission) =>
          inChat.has(permission.agentId),
        ),
      });
    }
  }
  return chats.sort(compareWaitingSince);
}

function compareWaitingSince(a: NeedsYouChat, b: NeedsYouChat): number {
  if (a.waitingSince === b.waitingSince) return a.key.localeCompare(b.key);
  if (a.waitingSince === null) return 1;
  if (b.waitingSince === null) return -1;
  return a.waitingSince - b.waitingSince;
}
