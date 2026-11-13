import { create } from "zustand";
import type { NoteAnchor } from "./model";

/** What an "Add note" entry point knows about the selection it came from. */
export interface NoteDraft {
  /** The host that owns the chat or terminal. The note is stored there. */
  serverId: string;
  /** The highlighted text, stored with the note so it survives scrollback trimming. */
  quote: string;
  anchor: NoteAnchor;
  /**
   * Waiting-on defaults. A chat selection defaults the agent picker to the thread's agent; a
   * terminal selection offers "command finishes" in that terminal, labelled with the command line
   * when the selection is one.
   */
  agentId?: string;
  terminalId?: string;
  command?: string;
}

export type NoteComposerRequest =
  | { mode: "create"; draft: NoteDraft }
  | { mode: "edit"; serverId: string; noteId: string };

interface NoteComposerState {
  request: NoteComposerRequest | null;
  open: (request: NoteComposerRequest) => void;
  close: () => void;
}

/** One composer for the whole app, mounted once at the root (`NoteComposerHost`). */
export const useNoteComposerStore = create<NoteComposerState>((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: () => set({ request: null }),
}));

export function openNoteComposer(draft: NoteDraft): void {
  useNoteComposerStore.getState().open({ mode: "create", draft });
}

export function openNoteEditor(serverId: string, noteId: string): void {
  useNoteComposerStore.getState().open({ mode: "edit", serverId, noteId });
}
