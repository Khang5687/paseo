import type { QuestionJumpInput } from "./jump-types";
import { whenMessageMounted } from "./jump-types";

/** Native: scroll the reply that asks the question to the top. Native has no line positions. */
export function jumpToQuestionMessage(input: QuestionJumpInput): void {
  whenMessageMounted(input, () => input.viewportRef.current?.scrollToMessage?.(input.messageId));
}
