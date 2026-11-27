import { afterEach, describe, expect, it } from "vitest";
import type { AgentOpenQuestion } from "@getpaseo/protocol/messages";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { questionAnswerScopeKey, saveQuestionAnswer, useQuestionAnswerStore } from "./answer-store";

const serverId = "answer-store-host";
const agentId = "answer-store-agent";

function question(label: string): AgentOpenQuestion {
  return { id: label, label, title: label, body: "", pick: null, askedAt: "2026-11-28T00:00:00Z" };
}

function agent(openQuestions: AgentOpenQuestion[]): Agent {
  return {
    serverId,
    id: agentId,
    provider: "claude",
    status: "idle",
    turn: { phase: "idle", cancellationRequestId: null },
    createdAt: new Date("2026-11-28T00:00:00.000Z"),
    updatedAt: new Date("2026-11-28T00:00:00.000Z"),
    lastUserMessageAt: null,
    lastActivityAt: new Date("2026-11-28T00:00:00.000Z"),
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: "default",
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: null,
    cwd: "/repo",
    workspaceId: "workspace-1",
    model: null,
    parentAgentId: null,
    labels: {},
    openQuestions,
  };
}

const localAnswers = () =>
  useQuestionAnswerStore.getState().answers[questionAnswerScopeKey(serverId, agentId)] ?? {};

describe("question answers on this device", () => {
  afterEach(() => {
    useSessionStore.getState().clearSession(serverId);
    useQuestionAnswerStore.setState({ answers: {} });
  });

  it("drops the half answer of a question the agent withdrew, so asking it again starts empty", () => {
    const store = useSessionStore.getState();
    store.initializeSession(serverId, null);
    store.setAgents(serverId, new Map([[agentId, agent([question("Q630"), question("Q653")])]]));
    saveQuestionAnswer({
      serverId,
      agentId,
      questionId: "Q630",
      answer: { pick: false, text: "ten minutes" },
    });
    saveQuestionAnswer({ serverId, agentId, questionId: "Q653", answer: { pick: true, text: "" } });
    expect(Object.keys(localAnswers())).toEqual(["Q630", "Q653"]);

    // The agent's ✖️ Q630 reached this device: only Q653 stays open.
    store.setAgents(serverId, new Map([[agentId, agent([question("Q653")])]]));
    expect(Object.keys(localAnswers())).toEqual(["Q653"]);

    store.setAgents(serverId, new Map([[agentId, agent([question("Q653"), question("Q630")])]]));
    expect(localAnswers().Q630).toBeUndefined();
  });
});
