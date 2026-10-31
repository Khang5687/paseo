import type { Logger } from "pino";
import { AGENT_ASK_DEFAULT_TIMEOUT_MS } from "@getpaseo/protocol/messages";

import type { AgentManager, AgentManagerEvent } from "./agent-manager.js";

const DENIED_PERMISSION_MESSAGE =
  "You are a temporary copy answering a question. You cannot run actions that need approval; answer from what you know and what you can read.";

export type AskAgentManager = Pick<
  AgentManager,
  | "forkAgentSession"
  | "resumeAgentFromPersistence"
  | "subscribe"
  | "respondToPermission"
  | "runAgent"
  | "cancelAgentRun"
  | "closeAgent"
  | "deleteAgentState"
>;

export interface AskAgentInput {
  agentId: string;
  question: string;
  /** Title of the asking agent, shown to the copy so it knows who is asking. */
  askedBy?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

class AskAgentTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`The forked copy did not answer within ${Math.round(timeoutMs / 1000)}s`);
    this.name = "AskAgentTimeoutError";
  }
}

function buildAskAgentPrompt(question: string, askedBy?: string): string {
  return [
    "[Paseo ask_agent] This is a temporary copy of your conversation. It was made so that " +
      `${askedBy ? `the agent "${askedBy}"` : "another agent"} can ask you a question without ` +
      "interrupting you. The original you keeps working and never sees this exchange; the copy " +
      "is deleted after you answer.",
    "Answer from what you already know, reading files if you need to. If the conversation " +
      "stops in the middle of a task, do not continue the task; the original is doing it. Do " +
      "not edit files, run commands that change anything, or message other agents. Reply with " +
      "the answer only.",
    "",
    "Question:",
    question,
  ].join("\n");
}

/**
 * Ask a question of a forked copy of an agent's conversation. The agent keeps running untouched;
 * the copy runs hidden in a read-only mode, auto-denies approval requests, and is deleted after.
 */
export async function askAgent(
  manager: AskAgentManager,
  logger: Logger,
  input: AskAgentInput,
): Promise<{ answer: string }> {
  input.signal?.throwIfAborted();
  const fork = await manager.forkAgentSession(input.agentId);
  let copyId: string | null = null;
  let unsubscribe: (() => void) | null = null;
  try {
    const copy = await manager.resumeAgentFromPersistence(fork.handle, {
      internal: true,
      modeId: fork.readOnlyModeId,
    });
    const copyAgentId = copy.id;
    copyId = copyAgentId;
    unsubscribe = manager.subscribe(
      (event: AgentManagerEvent) => {
        if (event.type !== "agent_stream" || event.event.type !== "permission_requested") return;
        manager
          .respondToPermission(copyAgentId, event.event.request.id, {
            behavior: "deny",
            message: DENIED_PERMISSION_MESSAGE,
          })
          .catch((error: unknown) => {
            logger.warn({ err: error, copyAgentId }, "ask_agent.permission_deny_failed");
          });
      },
      { agentId: copyAgentId, includeInternal: true },
    );
    const result = await runUntil(
      manager.runAgent(copyAgentId, buildAskAgentPrompt(input.question, input.askedBy)),
      input.timeoutMs ?? AGENT_ASK_DEFAULT_TIMEOUT_MS,
      input.signal,
      () => manager.cancelAgentRun(copyAgentId),
    );
    const answer = result.finalText.trim();
    if (!answer) {
      throw new Error(
        result.canceled
          ? "The forked copy was canceled before answering"
          : "The forked copy gave no answer",
      );
    }
    return { answer };
  } finally {
    unsubscribe?.();
    if (copyId) {
      await manager.closeAgent(copyId).catch((error: unknown) => {
        logger.warn({ err: error, copyId }, "ask_agent.close_failed");
      });
      await manager.deleteAgentState(copyId).catch(() => undefined);
    }
    await fork.discard().catch((error: unknown) => {
      logger.warn({ err: error, agentId: input.agentId }, "ask_agent.discard_failed");
    });
  }
}

async function runUntil<T>(
  run: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  cancel: () => Promise<unknown>,
): Promise<T> {
  // The server's lib predates Promise.withResolvers.
  let stop: (error: unknown) => void = () => {};
  const stopped = new Promise<never>((_, reject) => {
    stop = reject;
  });
  const timer = setTimeout(() => stop(new AskAgentTimeoutError(timeoutMs)), timeoutMs);
  const onAbort = () => stop(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([run, stopped]);
  } catch (error) {
    // A run outlives a lost race; cancel it before the caller closes the copy.
    await cancel().catch(() => undefined);
    run.catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
