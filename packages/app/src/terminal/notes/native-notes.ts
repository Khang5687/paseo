import type { NativeHeadlessTerminal } from "../native-renderer/headless-terminal-state";
import {
  extractTerminalSelectedText,
  type TerminalSelectionRange,
} from "../native-renderer/terminal-selection";
import {
  locateTerminalQuote,
  type TerminalQuoteBuffer,
  type TerminalQuoteLocation,
} from "./quote-location";
import type { TerminalNoteReveal, TerminalSelectionNoteContext } from "./terminal-note-types";

/**
 * The native grid numbers rows from the first row ever written; notes store rows the way xterm
 * does (0 = oldest row the buffer keeps), so every platform reads the same hint.
 */
export function nativeSelectionNoteContext(
  terminal: NativeHeadlessTerminal,
  selection: TerminalSelectionRange | null,
): TerminalSelectionNoteContext | null {
  if (!selection) return null;
  const text = extractTerminalSelectedText({ terminal, selection });
  if (text.trim().length === 0) return null;
  const { oldestRow } = terminal.getBufferBounds();
  return {
    text,
    startLine: selection.start.row - oldestRow,
    endLine: selection.end.row - oldestRow,
  };
}

function nativeQuoteBuffer(terminal: NativeHeadlessTerminal): TerminalQuoteBuffer {
  const bounds = terminal.getBufferBounds();
  return {
    firstRow: bounds.oldestRow,
    rowCount: bounds.newestRow - bounds.oldestRow + 1,
    cols: bounds.cols,
    getRow: (row) => {
      const window = terminal.getBufferWindow({ startRow: row, rowCount: 1 });
      const cells = window.startRow === row ? window.rows[0] : undefined;
      if (!cells) return null;
      const text = cells
        .filter((cell) => cell.width !== 0)
        .map((cell) => cell.char || " ")
        .join("")
        .trimEnd();
      return { text, wrapped: window.wrappedRows[0] === true };
    },
  };
}

/** Where a note's quote sits, in the native grid's row numbers. */
export function locateNativeNote(
  terminal: NativeHeadlessTerminal,
  input: TerminalNoteReveal,
): TerminalQuoteLocation | null {
  const { oldestRow } = terminal.getBufferBounds();
  return locateTerminalQuote({
    buffer: nativeQuoteBuffer(terminal),
    quote: input.quote,
    hintRow: input.startLine === undefined ? undefined : input.startLine + oldestRow,
  });
}
