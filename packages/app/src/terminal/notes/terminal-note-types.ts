import type { NoteHighlightKind } from "@/notes/model";

/**
 * Buffer lines here index the terminal's buffer the way xterm does: 0 is the oldest row the
 * buffer still keeps. They are hints only; rows shift as scrollback is trimmed, so notes are found
 * again by their quoted text.
 */

/** The selection an "Add note" draft quotes. */
export interface TerminalSelectionNoteContext {
  text: string;
  startLine: number;
  endLine: number;
}

/** A note drawn over its quote in the terminal. */
export interface TerminalNoteHighlight {
  id: string;
  quote: string;
  startLine?: number;
  kind: NoteHighlightKind;
}

/** "Jump to note": the quote to scroll to and select. */
export interface TerminalNoteReveal {
  quote: string;
  startLine?: number;
}

/** The selection's bounding box in the emulator's coordinates, with the emulator's size. */
export interface TerminalSelectionAnchor {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}
