import type { RefObject } from "react";
import type { StreamViewportHandle } from "@/agent-stream/strategy";

export interface QuestionJumpInput {
  messageId: string;
  label: string;
  viewportRef: RefObject<StreamViewportHandle | null>;
  /** Opens a folded turn or loads history so the row mounts; true when it had to. */
  revealLoadedMessage(messageId: string): boolean;
  isMounted(messageId: string): boolean;
}

// A folded turn mounts its rows a frame or more after it opens.
const MOUNT_FRAME_BUDGET = 60;

/** Runs `then` once the reply's row is mounted, opening its folded turn first if needed. */
export function whenMessageMounted(input: QuestionJumpInput, then: () => void): void {
  input.revealLoadedMessage(input.messageId);
  let frames = 0;
  const poll = () => {
    if (input.isMounted(input.messageId)) {
      then();
      return;
    }
    frames += 1;
    if (frames < MOUNT_FRAME_BUDGET) requestAnimationFrame(poll);
  };
  poll();
}
