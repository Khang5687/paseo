import { create } from "zustand";
import type { Note } from "./model";

export interface NoteFocusTarget {
  serverId: string;
  note: Note;
  /** Distinguishes two taps on the same note so the view scrolls again. */
  requestId: number;
}

interface NoteFocusState {
  target: NoteFocusTarget | null;
  focus: (serverId: string, note: Note) => void;
  /** The chat or terminal view calls this once it scrolled to and flashed the note. */
  clear: (requestId: number) => void;
}

let nextRequestId = 1;

/**
 * "Jump to the highlighted spot": `openNote` sets the target and navigates; the chat or terminal
 * view that owns the note's anchor scrolls to it, flashes it, and clears the target.
 */
export const useNoteFocusStore = create<NoteFocusState>((set) => ({
  target: null,
  focus: (serverId, note) => set({ target: { serverId, note, requestId: nextRequestId++ } }),
  clear: (requestId) =>
    set((state) => (state.target?.requestId === requestId ? { target: null } : state)),
}));
