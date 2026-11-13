import { useSessionStore } from "@/stores/session-store";
import { isHttpUrl } from "@/utils/http-url";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";

/** Agent label whose value is the full http(s) URL of the agent's task in an external tracker. */
export const AGENT_TASK_URL_LABEL = "task-url";

/** The agent's task URL, or null when the label is absent or not an http(s) URL. */
export function resolveAgentTaskUrl(labels: Record<string, string> | undefined): string | null {
  const value = labels?.[AGENT_TASK_URL_LABEL]?.trim();
  return value && isHttpUrl(value) ? value : null;
}

/** Task URL for the agent behind the active tab; null for other tab kinds. */
export function useAgentTaskUrl(
  serverId: string,
  descriptor: WorkspaceTabDescriptor | null,
): string | null {
  const agentId = descriptor?.target.kind === "agent" ? descriptor.target.agentId : null;
  return useSessionStore((state) =>
    agentId ? resolveAgentTaskUrl(state.sessions[serverId]?.agents.get(agentId)?.labels) : null,
  );
}
