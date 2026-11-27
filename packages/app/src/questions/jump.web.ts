import type { QuestionJumpInput } from "./jump-types";
import { whenMessageMounted } from "./jump-types";

const FLASH_KEYFRAMES: Keyframe[] = [
  { backgroundColor: "rgba(167, 139, 250, 0.35)" },
  { backgroundColor: "rgba(167, 139, 250, 0)" },
];

function findQuestionLine(messageId: string, label: string): HTMLElement | null {
  const asks = new RegExp(`^\\s*❓[*_\\s]*${label}\\b`, "i");
  const rows = document.querySelectorAll<HTMLElement>(
    `[data-message-id="${CSS.escape(messageId)}"]`,
  );
  for (const row of rows) {
    for (const block of row.querySelectorAll<HTMLElement>("p, li, h1, h2, h3, h4, h5, h6")) {
      if (asks.test(block.textContent ?? "")) return block;
    }
  }
  return null;
}

/** Web: land on the question's own ❓ line, not the top of its reply, and light it up once. */
export function jumpToQuestionMessage(input: QuestionJumpInput): void {
  whenMessageMounted(input, () => {
    const { messageId, label } = input;
    let flashed = false;
    input.viewportRef.current?.scrollToMessage?.(messageId, {
      signal: new AbortController().signal,
      targetTop() {
        const line = findQuestionLine(messageId, label);
        if (!line) return null;
        if (!flashed) {
          flashed = true;
          line.animate(FLASH_KEYFRAMES, { duration: 1600, easing: "ease-out" });
        }
        return line.getBoundingClientRect().top;
      },
    });
  });
}
