import type { AgentLifecycleStatus } from "./agent-lifecycle.js";
import type { AgentBackgroundWorkSummary, WorkspaceStateBucket } from "./messages.js";

export type { WorkspaceStateBucket };
export type AgentAttentionReason = "finished" | "error" | "permission" | null | undefined;

export interface AgentStateBucketInput {
  status: AgentLifecycleStatus;
  pendingPermissionCount?: number;
  requiresAttention?: boolean;
  attentionReason?: AgentAttentionReason;
  /**
   * The unread finished reply asks the user a question. Ranks the agent with pending permissions,
   * because either way the agent stopped until the user answers.
   */
  awaitingAnswer?: boolean;
  backgroundWork?: AgentBackgroundWorkSummary | null;
  /**
   * Questions from the agent's replies that the user has not answered. Unlike `awaitingAnswer`
   * they outlive reading the chat, so a settled agent stays waiting on the user until answered.
   */
  openQuestionCount?: number;
}

export function isAgentRunning(input: {
  status: AgentLifecycleStatus | null | undefined;
  backgroundWork?: AgentBackgroundWorkSummary | null;
}): boolean {
  const { status, backgroundWork } = input;
  return status === "running" || (backgroundWork?.runningCount ?? backgroundWork?.count ?? 0) > 0;
}

const WORKSPACE_STATE_BUCKET_PRIORITY = {
  needs_input: 0,
  failed: 1,
  running: 2,
  attention: 3,
  done: 4,
} as const satisfies Record<WorkspaceStateBucket, number>;

// An error is a notification like a finish: once the user has seen it, the agent stops showing as
// failed even though its lifecycle stays "error" until the next turn starts.
function hasUnreadError(input: AgentStateBucketInput): boolean {
  return input.requiresAttention === true && input.attentionReason === "error";
}

export function deriveAgentStateBucket(input: AgentStateBucketInput): WorkspaceStateBucket {
  if ((input.pendingPermissionCount ?? 0) > 0 || input.attentionReason === "permission") {
    return "needs_input";
  }
  if (hasUnreadError(input)) {
    return "failed";
  }
  // A turn in progress is working, even with questions open: the agent may be reading the answers.
  if (input.status === "running") {
    return "running";
  }
  // A finished turn that asks the user waits on the user, even while its background jobs run.
  if (input.requiresAttention && input.awaitingAnswer) {
    return "needs_input";
  }
  if ((input.openQuestionCount ?? 0) > 0) {
    return "needs_input";
  }
  if (isAgentRunning(input)) {
    return "running";
  }
  if (input.requiresAttention) {
    return "attention";
  }
  return "done";
}

export function getWorkspaceStateBucketPriority(bucket: WorkspaceStateBucket): number {
  return WORKSPACE_STATE_BUCKET_PRIORITY[bucket];
}

export function getAgentStatusPriority(input: AgentStateBucketInput): number {
  if ((input.pendingPermissionCount ?? 0) > 0 || input.attentionReason === "permission") {
    return 0;
  }
  if (hasUnreadError(input)) {
    return 1;
  }
  if (isAgentRunning(input)) {
    return 2;
  }
  if (input.status === "initializing") {
    return 3;
  }
  return 4;
}
