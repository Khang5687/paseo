import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import type { SessionInboundMessage, SessionOutboundMessage } from "../messages.js";
import type { SessionDelivery } from "../session/owned-subscriptions/index.js";
import type { AgentDraftChange, AgentDraftService } from "./agent-draft-service.js";

interface AgentDraftSessionDeps {
  service: AgentDraftService | null;
  delivery: SessionDelivery;
  clientId: string;
  emit: (message: SessionOutboundMessage) => void;
}

type DraftRequest<T extends SessionInboundMessage["type"]> = Extract<
  SessionInboundMessage,
  { type: T }
>;

/** Routes agent.draft.* requests for one client session. */
export function dispatchAgentDraftMessage(
  msg: SessionInboundMessage,
  deps: AgentDraftSessionDeps,
): Promise<void> | undefined {
  switch (msg.type) {
    case "agent.draft.subscribe.request":
      return subscribe(msg, deps);
    case "agent.draft.set.request":
      return set(msg, deps);
    case "agent.draft.restore.request":
      return restore(msg, deps);
    case "agent.draft.upload.get.request":
      return getUpload(msg, deps);
    default:
      return undefined;
  }
}

function requireService(deps: AgentDraftSessionDeps): AgentDraftService {
  if (!deps.service) throw new Error("This host does not sync drafts.");
  return deps.service;
}

async function subscribe(
  request: DraftRequest<"agent.draft.subscribe.request">,
  deps: AgentDraftSessionDeps,
): Promise<void> {
  const service = requireService(deps);
  if (!deps.delivery.isModern(deps.delivery.currentSource))
    throw new Error("Draft sync requires owned subscriptions");
  let stop: (() => void) | undefined;
  const owner = deps.delivery.begin("agent-draft", undefined, () => stop?.());
  let ready = false;
  let pending: AgentDraftChange | null = null;
  const emitChange = (change: AgentDraftChange) =>
    owner.emit({ type: "agent.draft.update", payload: change });
  stop = service.subscribe((change) => {
    if (change.agentId !== request.agentId) return;
    if (ready) emitChange(change);
    // Before the response, keep the newest change; history rides only on changes that carry it.
    else pending = { ...change, history: change.history ?? pending?.history };
  });
  try {
    const state = await service.getState(request.agentId);
    if (!state) throw new Error(`Agent not found: ${request.agentId}`);
    deps.emit({
      type: "agent.draft.subscribe.response",
      payload: {
        requestId: request.requestId,
        subscriptionId: owner.responseId,
        agentId: request.agentId,
        state,
        error: null,
      },
    });
    ready = true;
    if (pending) emitChange(pending);
  } catch (error) {
    await owner.release();
    deps.emit({
      type: "agent.draft.subscribe.response",
      payload: {
        requestId: request.requestId,
        agentId: request.agentId,
        state: null,
        error: getErrorMessage(error),
      },
    });
  }
}

async function set(
  request: DraftRequest<"agent.draft.set.request">,
  deps: AgentDraftSessionDeps,
): Promise<void> {
  try {
    const result = await requireService(deps).set(request.agentId, {
      text: request.text,
      attachments: request.attachments,
      updatedAt: request.updatedAt,
      baseRevision: request.baseRevision,
      reason: request.reason,
      clientId: deps.clientId,
    });
    if (!result) throw new Error(`Agent not found: ${request.agentId}`);
    deps.emit({
      type: "agent.draft.set.response",
      payload: { requestId: request.requestId, agentId: request.agentId, ...result, error: null },
    });
  } catch (error) {
    deps.emit({
      type: "agent.draft.set.response",
      payload: {
        requestId: request.requestId,
        agentId: request.agentId,
        accepted: false,
        state: null,
        error: getErrorMessage(error),
      },
    });
  }
}

async function restore(
  request: DraftRequest<"agent.draft.restore.request">,
  deps: AgentDraftSessionDeps,
): Promise<void> {
  try {
    const result = await requireService(deps).restore(request.agentId, {
      snapshotId: request.snapshotId,
      clientId: deps.clientId,
    });
    if (!result) throw new Error(`Agent not found: ${request.agentId}`);
    deps.emit({
      type: "agent.draft.restore.response",
      payload: {
        requestId: request.requestId,
        agentId: request.agentId,
        state: result.state,
        error: null,
      },
    });
  } catch (error) {
    deps.emit({
      type: "agent.draft.restore.response",
      payload: {
        requestId: request.requestId,
        agentId: request.agentId,
        state: null,
        error: getErrorMessage(error),
      },
    });
  }
}

async function getUpload(
  request: DraftRequest<"agent.draft.upload.get.request">,
  deps: AgentDraftSessionDeps,
): Promise<void> {
  try {
    const upload = await requireService(deps).readUpload(request.agentId, request.uploadId);
    deps.emit({
      type: "agent.draft.upload.get.response",
      payload: { requestId: request.requestId, uploadId: request.uploadId, ...upload, error: null },
    });
  } catch (error) {
    deps.emit({
      type: "agent.draft.upload.get.response",
      payload: {
        requestId: request.requestId,
        uploadId: request.uploadId,
        fileName: null,
        data: null,
        error: getErrorMessage(error),
      },
    });
  }
}
