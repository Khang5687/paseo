/** One buffer row as the terminal renders it. */
export interface TerminalQuoteRow {
  text: string;
  /** This row continues the previous row (soft wrap), so the two form one logical line. */
  wrapped: boolean;
}

export interface TerminalQuoteBuffer {
  /** Number of the oldest row; rows run `firstRow .. firstRow + rowCount - 1`. */
  firstRow: number;
  rowCount: number;
  cols: number;
  getRow(row: number): TerminalQuoteRow | null;
}

/** Where a quote sits in the buffer. `endCol` is exclusive. */
export interface TerminalQuoteLocation {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

interface LogicalLine {
  text: string;
  /** Row after the last row of this logical line. */
  nextRow: number;
}

function readLogicalLine(buffer: TerminalQuoteBuffer, startRow: number): LogicalLine | null {
  const lastRow = buffer.firstRow + buffer.rowCount - 1;
  const first = buffer.getRow(startRow);
  if (!first) return null;
  let text = first.text;
  let row = startRow + 1;
  while (row <= lastRow) {
    const next = buffer.getRow(row);
    if (!next?.wrapped) break;
    // A row that wraps fills every column, including trailing blanks.
    text = text.padEnd(buffer.cols * (row - startRow), " ") + next.text;
    row += 1;
  }
  return { text, nextRow: row };
}

function offsetToCell(
  buffer: TerminalQuoteBuffer,
  lineStartRow: number,
  offset: number,
): { row: number; col: number } {
  const cols = Math.max(1, buffer.cols);
  return { row: lineStartRow + Math.floor(offset / cols), col: offset % cols };
}

function endOffsetToCell(
  buffer: TerminalQuoteBuffer,
  lineStartRow: number,
  endOffset: number,
): { row: number; col: number } {
  if (endOffset <= 0) return { row: lineStartRow, col: 0 };
  const last = offsetToCell(buffer, lineStartRow, endOffset - 1);
  return { row: last.row, col: last.col + 1 };
}

/** Candidate rows nearest to `hint` first, alternating above and below. */
function* rowsByDistance(buffer: TerminalQuoteBuffer, hint: number): Generator<number> {
  const first = buffer.firstRow;
  const last = buffer.firstRow + buffer.rowCount - 1;
  const center = Math.min(Math.max(hint, first), last);
  for (let distance = 0; center - distance >= first || center + distance <= last; distance += 1) {
    if (center - distance >= first) yield center - distance;
    if (distance > 0 && center + distance <= last) yield center + distance;
  }
}

/**
 * Find a note's quote in the terminal buffer: the row whose logical line contains the quote's
 * first non-blank line, nearest to `hintRow` (the row recorded when the note was made; rows shift
 * as scrollback is trimmed). Without a hint the newest match wins. Later quote lines extend the
 * location over the following logical lines. `minRow` skips rows already searched.
 */
export function locateTerminalQuote(input: {
  buffer: TerminalQuoteBuffer;
  quote: string;
  hintRow?: number;
  minRow?: number;
}): TerminalQuoteLocation | null {
  const { buffer } = input;
  if (buffer.rowCount <= 0) return null;
  const lines = input.quote.split("\n").map((line) => line.trimEnd());
  while (lines.length > 0 && lines[lines.length - 1]!.trim().length === 0) lines.pop();
  const firstIndex = lines.findIndex((line) => line.trim().length > 0);
  if (firstIndex === -1) return null;
  const needle = lines[firstIndex]!.trim();
  const rest = lines.slice(firstIndex + 1);

  const hint = input.hintRow ?? buffer.firstRow + buffer.rowCount - 1;
  const minRow = input.minRow ?? buffer.firstRow;
  for (const row of rowsByDistance(buffer, hint)) {
    if (row < minRow) continue;
    if (buffer.getRow(row)?.wrapped) continue;
    const line = readLogicalLine(buffer, row);
    const column = line?.text.indexOf(needle) ?? -1;
    if (!line || column === -1) continue;

    const start = offsetToCell(buffer, row, column);
    let endLineRow = row;
    let endOffset = column + needle.length;
    let nextRow = line.nextRow;
    for (const quoteLine of rest) {
      if (nextRow > buffer.firstRow + buffer.rowCount - 1) break;
      const next = readLogicalLine(buffer, nextRow);
      if (!next) break;
      endLineRow = nextRow;
      endOffset = Math.min(quoteLine.length, next.text.length);
      nextRow = next.nextRow;
    }
    const end = endOffsetToCell(buffer, endLineRow, endOffset);
    return { startRow: start.row, startCol: start.col, endRow: end.row, endCol: end.col };
  }
  return null;
}

/** Each buffer row a location covers, with the columns to tint on it (`endCol` exclusive). */
export function terminalQuoteRowSpans(
  location: TerminalQuoteLocation,
  cols: number,
): Array<{ row: number; startCol: number; endCol: number }> {
  const spans: Array<{ row: number; startCol: number; endCol: number }> = [];
  for (let row = location.startRow; row <= location.endRow; row += 1) {
    const startCol = row === location.startRow ? location.startCol : 0;
    const endCol = row === location.endRow ? location.endCol : cols;
    if (endCol > startCol) spans.push({ row, startCol, endCol });
  }
  return spans;
}
