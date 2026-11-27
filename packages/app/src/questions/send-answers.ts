import type {
  ActiveTurnBehavior,
  AgentOpenQuestion,
  AgentQuestionAnswer,
} from "@getpaseo/protocol/messages";
import { dispatchComposerAgentMessage, type ComposerSendClient } from "@/composer/actions";
import { createMessageSubmissionWriter } from "@/composer/submission/writer";
import { selectAgentTurnPresentation, useSessionStore } from "@/stores/session-store";
import { encodeImages } from "@/utils/encode-images";
import { buildAnswerMessage } from "./answer-message";
import { clearQuestionAnswers } from "./answer-store";

/**
 * Send one agent the answered cards among its open questions, as one message with one line per
 * card, and forget those answers here once the host took it. Skipped cards stay open. Resolves
 * false when no card was answered, so nothing was sent.
 */
export async function sendQuestionAnswers(input: {
  client: ComposerSendClient;
  serverId: string;
  agentId: string;
  questions: readonly AgentOpenQuestion[];
  answerFor: (question: AgentOpenQuestion) => AgentQuestionAnswer | undefined;
  activeTurnBehavior: ActiveTurnBehavior;
}): Promise<boolean> {
  const { client, serverId, agentId, activeTurnBehavior } = input;
  const message = buildAnswerMessage(input.questions, input.answerFor);
  if (!message) return false;
  await dispatchComposerAgentMessage({
    client,
    agentId,
    text: message.text,
    attachments: message.files.map((file) => ({
      kind: "file" as const,
      attachment: { type: "uploaded_file" as const, ...file },
    })),
    encodeImages,
    submission: createMessageSubmissionWriter(serverId),
    activeTurnBehavior,
    activeTurnId:
      activeTurnBehavior === "steer"
        ? (selectAgentTurnPresentation(useSessionStore.getState().sessions[serverId], agentId)
            .turnId ?? undefined)
        : undefined,
  });
  clearQuestionAnswers({ serverId, agentId, questionIds: message.questionIds });
  return true;
}
