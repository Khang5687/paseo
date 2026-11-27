import { useEffect } from "react";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useNoteFocusStore } from "@/notes/focus-store";
import { useChatNoteFocusTarget } from "./context";
import type { ChatNotesSurfaceProps } from "./types";

/**
 * Native draws no inline highlight and its list cannot scroll to a message, so opening the
 * chat is the whole jump: a target for this chat is consumed once the chat is on screen.
 */
export function ChatNotesSurface({ children }: ChatNotesSurfaceProps) {
  const focus = useChatNoteFocusTarget();
  const active = useRetainedPanelActive();
  useEffect(() => {
    if (focus && active) useNoteFocusStore.getState().clear(focus.requestId);
  }, [active, focus]);
  return children;
}
