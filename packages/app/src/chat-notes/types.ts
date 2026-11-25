import type { ReactNode, RefObject } from "react";
import type { MountedMessageIds } from "@/agent-stream/chat-find/types";
import type { StreamViewportHandle } from "@/agent-stream/strategy";

/** The stream bindings a note jump needs to bring a message on screen. */
export interface ChatNotesSurfaceProps {
  viewportRef: RefObject<StreamViewportHandle | null>;
  revealLoadedMessage(messageId: string): boolean;
  visibleMessageIds: MountedMessageIds;
  children: ReactNode;
}
