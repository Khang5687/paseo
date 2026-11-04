import type { MessageSubmissionWriter } from "@/composer/actions";
import { useSessionStore } from "@/stores/session-store";
import { useSentMessageImagesStore } from "@/stores/sent-message-images-store";
import {
  appendSubmittedUserMessage,
  removeSubmittedUserMessage,
  type UserMessageItem,
} from "@/types/stream";

function recordSentMessageImages(serverId: string, agentId: string, message: UserMessageItem) {
  if (!message.clientMessageId || !message.images) return;
  useSentMessageImagesStore.getState().record({
    serverId,
    agentId,
    messageId: message.clientMessageId,
    images: message.images,
  });
}

function forgetSentMessageImages(serverId: string, agentId: string, clientMessageId: string) {
  useSentMessageImagesStore.getState().remove({ serverId, agentId, messageId: clientMessageId });
}

function appendUntrackedSubmission(serverId: string, agentId: string, message: UserMessageItem) {
  const session = useSessionStore.getState().sessions[serverId];
  if (!session) return;
  const tail = session.agentStreamTail.get(agentId) ?? [];
  const head = session.agentStreamHead.get(agentId) ?? [];
  useSessionStore
    .getState()
    .setAgentStreamState(serverId, agentId, appendSubmittedUserMessage({ tail, head, message }));
}

function removeUntrackedSubmission(
  serverId: string,
  agentId: string,
  clientMessageId: string,
): void {
  const session = useSessionStore.getState().sessions[serverId];
  if (!session) return;
  const tail = session.agentStreamTail.get(agentId) ?? [];
  const head = session.agentStreamHead.get(agentId) ?? [];
  useSessionStore
    .getState()
    .setAgentStreamState(
      serverId,
      agentId,
      removeSubmittedUserMessage({ tail, head, clientMessageId }),
    );
}

function createUntrackedMessageSubmissionWriter(serverId: string): MessageSubmissionWriter {
  return {
    begin: (agentId, message) => {
      recordSentMessageImages(serverId, agentId, message);
      appendUntrackedSubmission(serverId, agentId, message);
    },
    accept: () => undefined,
    reject: (agentId, clientMessageId) => {
      forgetSentMessageImages(serverId, agentId, clientMessageId);
      removeUntrackedSubmission(serverId, agentId, clientMessageId);
      return "rejected";
    },
  };
}

export function createMessageSubmissionWriter(serverId: string): MessageSubmissionWriter {
  const supportsTrackedMessageSubmissions =
    useSessionStore.getState().sessions[serverId]?.serverInfo?.features
      ?.canonicalSubmittedPrompts === true;
  if (!supportsTrackedMessageSubmissions) {
    // COMPAT(canonicalSubmittedPrompts): added in v0.2.6; remove the gate after 2027-01-31 once daemon floor >= v0.2.6.
    return createUntrackedMessageSubmissionWriter(serverId);
  }
  return {
    begin: (agentId, message) => {
      recordSentMessageImages(serverId, agentId, message);
      useSessionStore.getState().beginAgentMessageSubmission(serverId, agentId, message);
    },
    accept: (agentId, clientMessageId) =>
      useSessionStore.getState().acceptAgentMessageSubmission(serverId, agentId, clientMessageId),
    reject: (agentId, clientMessageId) => {
      forgetSentMessageImages(serverId, agentId, clientMessageId);
      return useSessionStore
        .getState()
        .rejectAgentMessageSubmission(serverId, agentId, clientMessageId);
    },
  };
}

export function handoffCreatedAgentMessageSubmission(
  serverId: string,
  agentId: string,
  message: UserMessageItem,
): boolean {
  recordSentMessageImages(serverId, agentId, message);
  return useSessionStore.getState().handoffCreatedAgentUserMessage(serverId, agentId, message);
}
