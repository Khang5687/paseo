import { create } from "zustand";
import type { AgentQuestionAnswer } from "@getpaseo/protocol/messages";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { selectHostFeature } from "@/runtime/host-features";
import { useSessionStore } from "@/stores/session-store";

/**
 * This device's answers to open questions, keyed by host and agent. The host keeps a copy on
 * the question itself (`AgentOpenQuestion.answer`), so a half-answered set of cards shows the
 * same picks on every device; the newer copy wins (`resolveAnswer`). Hosts without
 * `features.questionAnswers` never see them, and the answers stay on this device until sent.
 */
interface QuestionAnswerState {
  answers: Record<string, Record<string, AgentQuestionAnswer>>;
}

export const useQuestionAnswerStore = create<QuestionAnswerState>(() => ({ answers: {} }));

const PUSH_DELAY_MS = 400;
const pushTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function questionAnswerScopeKey(serverId: string, agentId: string): string {
  return `${serverId}\u0000${agentId}`;
}

export function saveQuestionAnswer(input: {
  serverId: string;
  agentId: string;
  questionId: string;
  answer: Omit<AgentQuestionAnswer, "updatedAt">;
}): void {
  const scope = questionAnswerScopeKey(input.serverId, input.agentId);
  const answer: AgentQuestionAnswer = { ...input.answer, updatedAt: Date.now() };
  useQuestionAnswerStore.setState((state) => ({
    answers: {
      ...state.answers,
      [scope]: { ...state.answers[scope], [input.questionId]: answer },
    },
  }));
  schedulePush(input.serverId, input.agentId, input.questionId);
}

/** Drops this device's copies once a message answered them; the host drops the questions. */
export function clearQuestionAnswers(input: {
  serverId: string;
  agentId: string;
  questionIds: readonly string[];
}): void {
  const scope = questionAnswerScopeKey(input.serverId, input.agentId);
  useQuestionAnswerStore.setState((state) => {
    const current = state.answers[scope];
    if (!current) return state;
    const next = { ...current };
    for (const questionId of input.questionIds) {
      delete next[questionId];
      const timerKey = `${scope}\u0000${questionId}`;
      clearTimeout(pushTimers.get(timerKey));
      pushTimers.delete(timerKey);
    }
    return { answers: { ...state.answers, [scope]: next } };
  });
}

// Typing writes on every key; the host gets the answer once the typing pauses.
function schedulePush(serverId: string, agentId: string, questionId: string): void {
  if (!selectHostFeature(useSessionStore.getState(), serverId, "questionAnswers")) return;
  const scope = questionAnswerScopeKey(serverId, agentId);
  const timerKey = `${scope}\u0000${questionId}`;
  clearTimeout(pushTimers.get(timerKey));
  pushTimers.set(
    timerKey,
    setTimeout(() => {
      pushTimers.delete(timerKey);
      const answer = useQuestionAnswerStore.getState().answers[scope]?.[questionId];
      const client = getHostRuntimeStore().getClient(serverId);
      if (!answer || !client) return;
      void client
        .setAgentQuestionAnswer({ agentId, questionId, answer })
        .catch((error) => console.warn("[questions] Failed to save answer", error));
    }, PUSH_DELAY_MS),
  );
}
