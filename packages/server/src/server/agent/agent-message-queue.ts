import type { Logger } from "pino";
import type { ActiveTurnBehavior, AgentQueuedMessagePayload } from "../messages.js";
import type { AgentManager } from "./agent-manager.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import { sendPromptToAgent, waitForAgentRunStartWithTimeout } from "./agent-prompt.js";
import type { AgentStorage } from "./agent-storage.js";
import { buildAgentPrompt } from "./prompt-attachments.js";

export interface AgentMessageQueueDispatcherOptions {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
}

/**
 * Drains the daemon-owned message queue: whenever an agent settles idle with
 * nothing blocking it, messages queued, and the queue not paused, the head is
 * sent through the same path `send_agent_message` uses. One dispatch per agent
 * is in flight at a time, and the dispatch holds the slot until the run has
 * actually started so the idle state preceding a run start cannot drain a
 * second entry. Pausing only stops the automatic drain; send-now still works.
 *
 * An entry is never dropped. If the send fails before the provider admitted
 * the prompt, the entry goes back to the head; an automatic drain also pauses
 * the queue with the error as its reason, so the failure cannot loop.
 */
export class AgentMessageQueueDispatcher {
  private readonly agentManager: AgentManager;
  private readonly agentStorage: AgentStorage;
  private readonly logger: Logger;
  private readonly inFlight = new Map<string, Promise<void>>();
  private unsubscribe: (() => void) | null = null;

  constructor(options: AgentMessageQueueDispatcherOptions) {
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
    this.logger = options.logger;
  }

  attach(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.agentManager.subscribe(
      (event) => {
        if (event.type !== "agent_state") return;
        const agent = event.agent;
        if (agent.lifecycle !== "idle") return;
        if (agent.pendingPermissions.size > 0) return;
        if (agent.queuedMessages.length === 0) return;
        if (agent.queuePaused) return;
        this.dispatch(agent.id, { reason: "idle" });
      },
      { replayState: false },
    );
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /**
   * Sends one specific queued message immediately, regardless of agent state.
   * Rejects if another dispatch for the agent is already in flight.
   */
  async sendNow(
    agentId: string,
    messageId: string,
    activeTurnBehavior: ActiveTurnBehavior,
  ): Promise<void> {
    if (this.inFlight.has(agentId)) {
      throw new Error("A queued message is already being sent to this agent");
    }
    await this.dispatch(agentId, { reason: "send_now", messageId, activeTurnBehavior });
  }

  /**
   * Drains the head if the agent is currently idle and its queue is not paused.
   * Called after an add, so a message queued against an agent that already
   * finished does not sit until the next state event, and after unpausing.
   */
  drainIfIdle(agentId: string): void {
    const agent = this.agentManager.getAgent(agentId);
    if (!agent) return;
    if (agent.lifecycle !== "idle") return;
    if (agent.pendingPermissions.size > 0) return;
    if (agent.queuedMessages.length === 0) return;
    if (agent.queuePaused) return;
    this.dispatch(agentId, { reason: "idle" });
  }

  /**
   * Loads every stored agent whose queue would drain (non-empty, not paused,
   * not archived) so it drains without a client opening it. Called once after
   * daemon start; loads one agent at a time so a long list cannot stampede
   * the providers. A failed load leaves the queue in the record.
   */
  async drainStoredQueues(): Promise<void> {
    const records = await this.agentStorage.list();
    for (const record of records) {
      if (record.archivedAt || record.internal || record.queuePaused) continue;
      if (!record.queuedMessages?.length) continue;
      try {
        await ensureAgentLoaded(record.id, {
          agentManager: this.agentManager,
          agentStorage: this.agentStorage,
          logger: this.logger,
        });
        this.drainIfIdle(record.id);
      } catch (error) {
        this.logger.error(
          { err: error, agentId: record.id },
          "Failed to load agent to drain its stored queue",
        );
      }
    }
  }

  private dispatch(
    agentId: string,
    options: {
      reason: "idle" | "send_now";
      messageId?: string;
      activeTurnBehavior?: ActiveTurnBehavior;
    },
  ): Promise<void> {
    const existing = this.inFlight.get(agentId);
    if (existing) return existing;
    const run = this.run(agentId, options).finally(() => {
      if (this.inFlight.get(agentId) === run) {
        this.inFlight.delete(agentId);
      }
    });
    this.inFlight.set(agentId, run);
    return run;
  }

  private async run(
    agentId: string,
    options: {
      reason: "idle" | "send_now";
      messageId?: string;
      activeTurnBehavior?: ActiveTurnBehavior;
    },
  ): Promise<void> {
    let message: AgentQueuedMessagePayload | null = null;
    let admitted = false;
    try {
      message = await this.agentManager.takeQueuedMessage(agentId, options.messageId);
      if (!message) {
        if (options.messageId) {
          throw new Error(`Queued message '${options.messageId}' not found`);
        }
        return;
      }
      this.logger.info(
        {
          agentId,
          messageId: message.id,
          reason: options.reason,
          imageCount: message.images.length,
          attachmentCount: message.attachments.length,
        },
        "Dispatching queued agent message",
      );
      // The entry id doubles as the clientMessageId. Without one the manager
      // records no canonical user_message for a steered dispatch (providers do
      // not echo steered prompts), and a client that pre-renders the entry on
      // send-now has nothing to reconcile its row against.
      const result = await sendPromptToAgent({
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        agentId,
        prompt: buildAgentPrompt(message.text, message.images, message.attachments),
        messageId: message.id,
        activeTurnBehavior: options.activeTurnBehavior ?? "steer",
        clearPendingPermissions: true,
        logger: this.logger,
      });
      // From here the prompt belongs to the provider. A run-start wait that
      // times out or fails does not un-send it (a rejected start is already in
      // the timeline as a rejected message), so requeueing would duplicate it.
      admitted = true;
      if (result.disposition === "turn_started") {
        await waitForAgentRunStartWithTimeout(this.agentManager, agentId);
      }
    } catch (error) {
      this.logger.error(
        { err: error, agentId, messageId: message?.id ?? options.messageId ?? null, admitted },
        "Failed to dispatch queued agent message",
      );
      if (message && !admitted) {
        await this.requeue(agentId, message, options.reason, error);
      }
      if (options.reason === "send_now") {
        throw error;
      }
    }
  }

  private async requeue(
    agentId: string,
    message: AgentQueuedMessagePayload,
    reason: "idle" | "send_now",
    error: unknown,
  ): Promise<void> {
    try {
      // Send-now has a caller to show the error to, so it only restores the
      // entry. An automatic drain has no one watching: pause and say why.
      await this.agentManager.requeueQueuedMessage(
        agentId,
        message,
        reason === "idle"
          ? { pauseReason: error instanceof Error ? error.message : String(error) }
          : undefined,
      );
    } catch (requeueError) {
      this.logger.error(
        { err: requeueError, agentId, messageId: message.id },
        "Failed to requeue undelivered queued agent message",
      );
    }
  }
}
