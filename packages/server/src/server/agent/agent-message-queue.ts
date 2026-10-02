import type { Logger } from "pino";
import type { ActiveTurnBehavior, AgentQueuedMessagePayload } from "../messages.js";
import type { AgentManager } from "./agent-manager.js";
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
 * nothing blocking it and messages queued, the head is sent through the same
 * path `send_agent_message` uses. One dispatch per agent is in flight at a
 * time, and the dispatch holds the slot until the run has actually started so
 * the idle state preceding a run start cannot drain a second entry.
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
   * Drains the head if the agent is currently idle. Called after an add so a
   * message queued against an agent that already finished does not sit until
   * the next state event.
   */
  drainIfIdle(agentId: string): void {
    const agent = this.agentManager.getAgent(agentId);
    if (!agent) return;
    if (agent.lifecycle !== "idle") return;
    if (agent.pendingPermissions.size > 0) return;
    if (agent.queuedMessages.length === 0) return;
    this.dispatch(agentId, { reason: "idle" });
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
      const result = await sendPromptToAgent({
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        agentId,
        prompt: buildAgentPrompt(message.text, message.images, message.attachments),
        activeTurnBehavior: options.activeTurnBehavior ?? "steer",
        clearPendingPermissions: true,
        logger: this.logger,
      });
      if (result.disposition === "turn_started") {
        await waitForAgentRunStartWithTimeout(this.agentManager, agentId);
      }
    } catch (error) {
      this.logger.error(
        { err: error, agentId, messageId: message?.id ?? options.messageId ?? null },
        "Failed to dispatch queued agent message",
      );
      // The entry is already popped; it stays dropped so a persistent failure
      // cannot loop on every idle transition. Send-now callers get the error.
      if (options.reason === "send_now") {
        throw error;
      }
    }
  }
}
