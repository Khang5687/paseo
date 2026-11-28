import { isDelegatedAgent } from "../agent-labels.js";

/** A chat voice can move to: a top-level agent that is not archived. */
export interface VoiceChat {
  agentId: string;
  workspaceId: string;
  title: string | null;
  /** Last user message (or update) time, ms. */
  lastActiveAt: number;
}

export interface VoiceChatProject {
  projectId: string;
  /** The name the sidebar shows. */
  name: string;
  /** Newest first. */
  chats: VoiceChat[];
}

interface DirectoryProject {
  projectId: string;
  displayName: string;
  customName: string | null;
  archivedAt: string | null;
}

interface DirectoryWorkspace {
  workspaceId: string;
  projectId: string;
}

interface DirectoryAgent {
  id: string;
  workspaceId?: string;
  title: string | null;
  labels: Record<string, string>;
  archivedAt?: string | Date | null;
  internal?: boolean;
  /** Background agents stay out of the sidebar, so voice never names them either. */
  background?: boolean;
  lastUserMessageAt: string | Date | null;
  updatedAt: string | Date;
}

function activityTime(agent: DirectoryAgent): number {
  const value = agent.lastUserMessageAt ?? agent.updatedAt;
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

/**
 * Projects with the chats voice can name. Subagents are left out: a chat is what the owner talks
 * to. `workspaces` are the active ones, so chats in archived workspaces are left out too. The
 * daemon builds it from its own registries; the app builds one per connected host from its replica.
 */
export function buildVoiceChatDirectory(input: {
  projects: DirectoryProject[];
  workspaces: DirectoryWorkspace[];
  agents: DirectoryAgent[];
}): VoiceChatProject[] {
  const projectByWorkspace = new Map(input.workspaces.map((w) => [w.workspaceId, w.projectId]));
  const chatsByProject = new Map<string, VoiceChat[]>();
  for (const agent of input.agents) {
    if (
      agent.archivedAt ||
      agent.internal ||
      agent.background ||
      isDelegatedAgent(agent) ||
      !agent.workspaceId
    ) {
      continue;
    }
    const projectId = projectByWorkspace.get(agent.workspaceId);
    if (!projectId) continue;
    const chats = chatsByProject.get(projectId) ?? [];
    chats.push({
      agentId: agent.id,
      workspaceId: agent.workspaceId,
      title: agent.title,
      lastActiveAt: activityTime(agent),
    });
    chatsByProject.set(projectId, chats);
  }
  return input.projects
    .filter((project) => !project.archivedAt)
    .map((project) => ({
      projectId: project.projectId,
      name: project.customName?.trim() || project.displayName,
      chats: (chatsByProject.get(project.projectId) ?? []).sort(
        (left, right) => right.lastActiveAt - left.lastActiveAt,
      ),
    }));
}
