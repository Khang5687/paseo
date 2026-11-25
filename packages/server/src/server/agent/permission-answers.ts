import { z } from "zod";

import type { AgentPermissionRequest, AgentPermissionResponse } from "./agent-sdk-types.js";

const QuestionsInputSchema = z.object({
  questions: z.array(z.object({ header: z.string() }).passthrough()).min(1),
});

/**
 * Turn an agent's answers to a question box into the response the user's tap sends: answers
 * keyed by each question's header, as a comma-joined string (Claude Code's native format) and as
 * a list (which every provider prefers, because a label may contain a comma).
 */
export function buildQuestionAnswerResponse(
  request: Pick<AgentPermissionRequest, "kind" | "input">,
  answers: Record<string, string[]>,
): AgentPermissionResponse {
  const questions = QuestionsInputSchema.safeParse(request.input).data?.questions;
  if (!questions) {
    throw new Error(
      `This ${request.kind} request has no questions to answer. Pass response instead: { behavior: "allow" } or { behavior: "deny", message }.`,
    );
  }
  const headers = questions.map((question) => question.header);
  const unknown = Object.keys(answers).filter((header) => !headers.includes(header));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown question header ${unknown.map((header) => `"${header}"`).join(", ")}. Headers: ${headers.map((header) => `"${header}"`).join(", ")}.`,
    );
  }
  const unanswered = headers.filter((header) => !(header in answers));
  if (unanswered.length > 0) {
    throw new Error(
      `Answer every question. Missing: ${unanswered.map((header) => `"${header}"`).join(", ")}.`,
    );
  }
  const answerLists = Object.fromEntries(
    questions.map(({ header }) => [
      header,
      answers[header]!.map((answer) => answer.trim()).filter(Boolean),
    ]),
  );
  return {
    behavior: "allow",
    updatedInput: {
      ...request.input,
      answers: Object.fromEntries(
        Object.entries(answerLists).map(([header, list]) => [header, list.join(", ")]),
      ),
      answerLists,
    },
  };
}

/** respond_to_permission takes either a raw response or question answers, never both. */
export async function resolvePermissionResponse(input: {
  agentId: string;
  requestId: string;
  response?: AgentPermissionResponse;
  answers?: Record<string, string[]>;
  loadRequest: () => Promise<Pick<AgentPermissionRequest, "kind" | "input"> | undefined>;
}): Promise<AgentPermissionResponse> {
  if (input.response && !input.answers) return input.response;
  if (!input.answers || input.response) {
    throw new Error("Pass exactly one of response or answers.");
  }
  const request = await input.loadRequest();
  if (!request) {
    throw new Error(`Agent ${input.agentId} has no open request ${input.requestId}`);
  }
  return buildQuestionAnswerResponse(request, input.answers);
}
