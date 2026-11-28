import {
  buildVoiceChatDirectory,
  type VoiceChatProject,
} from "@getpaseo/protocol/voice/chat-directory";
import {
  findHostMatches,
  type VoiceHostChats,
  type VoiceHostMatch,
} from "@getpaseo/protocol/voice/chat-match";
import type {
  VoiceNavigateFindChatsRequestPayload,
  VoiceNavigateFindChatsResponsePayload,
} from "@getpaseo/protocol/messages";
import { getHostRuntimeStore, isHostRuntimeConnected } from "@/runtime/host-runtime";
import { useSessionStore, type SessionState } from "@/stores/session-store";

type VoiceFindChatsQuery = VoiceNavigateFindChatsRequestPayload["query"];

/** One host's chats as voice names them, from the app's copy of that host. */
export function buildHostVoiceDirectory(
  session: Pick<SessionState, "projects" | "workspaces" | "agents">,
): VoiceChatProject[] {
  const projects = new Map<string, { displayName: string; customName: string | null }>();
  for (const project of session.projects.values()) {
    projects.set(project.projectId, {
      displayName: project.projectDisplayName,
      customName: project.projectCustomName,
    });
  }
  const workspaces = [];
  for (const workspace of session.workspaces.values()) {
    if (workspace.archivingAt) continue;
    workspaces.push({ workspaceId: workspace.id, projectId: workspace.projectId });
    // A workspace can arrive before its project list does; it carries the project's names too.
    if (!projects.has(workspace.projectId)) {
      projects.set(workspace.projectId, {
        displayName: workspace.projectDisplayName,
        customName: workspace.projectCustomName ?? null,
      });
    }
  }
  return buildVoiceChatDirectory({
    projects: [...projects].map(([projectId, names]) => ({
      projectId,
      displayName: names.displayName,
      customName: names.customName,
      archivedAt: null,
    })),
    workspaces,
    agents: [...session.agents.values()],
  });
}

/** What the asking host is told: the best match on each other host, or the one chat it named. */
export function findVoiceChatsOnHosts(
  query: VoiceFindChatsQuery,
  hosts: VoiceHostChats[],
): VoiceHostMatch[] {
  if (query.kind === "name") return findHostMatches(query.target, hosts);
  const host = hosts.find((candidate) => candidate.serverId === query.serverId);
  if (!host) return [];
  for (const project of host.projects) {
    if (project.chats.some((chat) => chat.agentId === query.agentId)) {
      return [
        {
          serverId: host.serverId,
          hostName: host.hostName,
          online: host.online,
          project,
          chatAgentId: query.agentId,
          score: 1,
        },
      ];
    }
  }
  return [];
}

/**
 * Answers `voice.navigate.find_chats.request` from `askingServerId`. Only the matched project
 * (with its chats, for "which one?") leaves the app: the asking host never sees the other hosts'
 * full lists. An offline host keeps the chats the app last saw, so voice can say where a chat is
 * even when it cannot go there.
 */
export function answerVoiceFindChatsRequest(
  askingServerId: string,
  request: VoiceNavigateFindChatsRequestPayload,
): VoiceNavigateFindChatsResponsePayload {
  const runtime = getHostRuntimeStore();
  const sessions = useSessionStore.getState().sessions;
  const profiles = runtime.getHosts();
  const hosts: VoiceHostChats[] = [];
  for (const profile of profiles) {
    const session = sessions[profile.serverId];
    if (profile.serverId === askingServerId || !session) continue;
    hosts.push({
      serverId: profile.serverId,
      hostName: profile.label,
      online: isHostRuntimeConnected(runtime.getSnapshot(profile.serverId)),
      projects: buildHostVoiceDirectory(session),
    });
  }
  const askingHost = profiles.find((profile) => profile.serverId === askingServerId);
  return {
    requestId: request.requestId,
    hostName: askingHost?.label ?? "",
    matches: findVoiceChatsOnHosts(request.query, hosts),
  };
}
