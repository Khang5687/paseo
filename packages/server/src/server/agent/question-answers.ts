import type { AgentMetadata } from "./agent-sdk-types.js";

/**
 * The app answers a question twice in `updatedInput`: `answers[header]` joins the answers with
 * ", " (Claude Code's native format), and `answerLists[header]` lists the checked option labels
 * in option order, then the Other text. Providers that need the answers one by one read the
 * list, because splitting the joined string breaks any label or custom answer with a comma.
 *
 * Returns null when the app sent no list for this question.
 */
export function readQuestionAnswerList(
  updatedInput: AgentMetadata | undefined,
  header: string,
): string[] | null {
  const answerLists = updatedInput?.answerLists;
  if (!answerLists || typeof answerLists !== "object" || Array.isArray(answerLists)) return null;
  const answerList: unknown = Reflect.get(answerLists, header);
  return Array.isArray(answerList) && answerList.every((item) => typeof item === "string")
    ? answerList
    : null;
}
