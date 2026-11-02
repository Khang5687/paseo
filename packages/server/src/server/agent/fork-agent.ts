import type { Logger } from "pino";
import type { AgentAttachment } from "@getpaseo/protocol/messages";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";
import { buildAgentForkContextAttachment, resolveForkCutPoint } from "./activity-curator.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import { sendPreparedPromptToAgent } from "./agent-prompt.js";
import { buildAgentPrompt } from "./prompt-attachments.js";

export type AgentForkMethod = "native" | "native_with_summary" | "summary";

export interface ForkAgentInput {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
  agentId: string;
  boundaryCursor?: { epoch: string; seq: number };
  boundaryMessageId?: string;
  /** Title of the source agent, shown in the summary and used to name the fork. */
  agentTitle: string | null;
}

export interface ForkAgentResult {
  agent: ManagedAgent;
  method: AgentForkMethod;
}

const COMPACTED_HISTORY_PROMPT =
  "This chat was forked. The provider compacted the oldest part of the source conversation before the fork, so the attached chat history is a summary of that part. Treat it as background. Reply with OK only and wait for the next message.";

const SUMMARY_FORK_PROMPT =
  "This chat was forked from another chat. The attached chat history is everything up to the fork point. Treat it as background. Reply with OK only and wait for the next message.";

/**
 * First message for a fork spawned to work on a different task than its source. The fork inherits
 * the source conversation, so without this it would continue the source's work.
 */
export function buildForkTaskPrompt(prompt: string): string {
  return `You are a fork of another agent, started to work on a separate task. Your conversation so far is the context you inherited. Do not continue the task the original agent was working on; the original keeps working on it. Your task:\n\n${prompt}`;
}
function hasConversation(rows: readonly { item: { type: string } }[]): boolean {
  return rows.some(
    (row) => row.item.type === "user_message" || row.item.type === "assistant_message",
  );
}

async function sendContextMessage(
  input: ForkAgentInput,
  agentId: string,
  text: string,
  attachment: AgentAttachment,
): Promise<void> {
  await sendPreparedPromptToAgent({
    agentManager: input.agentManager,
    agentStorage: input.agentStorage,
    agentId,
    prompt: buildAgentPrompt(text, undefined, [attachment]),
    activeTurnBehavior: "interrupt",
    logger: input.logger,
  });
}

/**
 * Fork an agent into a new agent. The one operation behind the Fork button, the /fork command and
 * the fork agent tool.
 *
 * - Provider with native session fork: fork its session cut at the boundary. If the fork
 *   would not fit the model's context window and the source had compacted history away, add ONE
 *   message carrying a summary of that compacted history.
 * - Any other provider: a fresh agent whose first message is the chat-history summary.
 */
export async function forkAgent(input: ForkAgentInput): Promise<ForkAgentResult> {
  const snapshot = await ensureAgentLoaded(input.agentId, {
    agentManager: input.agentManager,
    agentStorage: input.agentStorage,
    logger: input.logger,
  });
  const timeline = input.agentManager.fetchTimeline(input.agentId, {
    direction: "tail",
    limit: 0,
  });
  const cursorBoundary = input.boundaryCursor
    ? { timelineEpoch: timeline.epoch, cursor: input.boundaryCursor }
    : null;
  const title = input.agentTitle ? `${input.agentTitle} (fork)` : null;

  if (!input.agentManager.supportsNativeFork(snapshot.provider)) {
    const context = buildAgentForkContextAttachment({
      rows: timeline.rows,
      cursorBoundary,
      boundaryMessageId: input.boundaryMessageId,
      agentTitle: input.agentTitle,
      cwd: snapshot.cwd,
    });
    const agent = await input.agentManager.createForkSummaryAgent(input.agentId, { title });
    await sendContextMessage(input, agent.id, SUMMARY_FORK_PROMPT, context.attachment);
    return { agent, method: "summary" };
  }

  const cut = resolveForkCutPoint({
    rows: timeline.rows,
    cursorBoundary,
    boundaryMessageId: input.boundaryMessageId,
  });
  const forked = await input.agentManager.forkAgentSession(input.agentId, {
    cutBeforeMessageId: cut.cutBeforeMessageId,
    title,
  });
  await input.agentManager.hydrateTimelineFromProvider(forked.agent.id);

  const wontFit =
    forked.contextWindowUsedTokens !== undefined &&
    forked.contextWindowMaxTokens !== undefined &&
    forked.contextWindowUsedTokens > forked.contextWindowMaxTokens;
  if (!wontFit || !hasConversation(cut.compactedRows)) {
    return { agent: forked.agent, method: "native" };
  }
  const compacted = buildAgentForkContextAttachment({
    rows: cut.compactedRows,
    agentTitle: input.agentTitle,
    cwd: snapshot.cwd,
  });
  await sendContextMessage(input, forked.agent.id, COMPACTED_HISTORY_PROMPT, compacted.attachment);
  return { agent: forked.agent, method: "native_with_summary" };
}
