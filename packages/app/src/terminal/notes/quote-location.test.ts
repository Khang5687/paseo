import { describe, expect, it } from "vitest";

import {
  locateTerminalQuote,
  terminalQuoteRowSpans,
  type TerminalQuoteBuffer,
} from "./quote-location";

function buffer(rows: Array<string | { text: string; wrapped: true }>, cols = 20, firstRow = 0) {
  const entries = rows.map((row) =>
    typeof row === "string" ? { text: row, wrapped: false } : row,
  );
  const result: TerminalQuoteBuffer = {
    firstRow,
    rowCount: entries.length,
    cols,
    getRow: (row) => entries[row - firstRow] ?? null,
  };
  return result;
}

describe("locateTerminalQuote", () => {
  it("finds a single-line quote inside its row", () => {
    const location = locateTerminalQuote({
      buffer: buffer(["$ npm test", "PASS src/a.test.ts", "Done in 2s"]),
      quote: "src/a.test.ts",
    });

    expect(location).toEqual({ startRow: 1, startCol: 5, endRow: 1, endCol: 18 });
  });

  it("prefers the match nearest the recorded row", () => {
    const rows = ["error: boom", "ok", "ok", "ok", "error: boom", "ok"];

    expect(locateTerminalQuote({ buffer: buffer(rows), quote: "error: boom", hintRow: 1 })).toEqual(
      { startRow: 0, startCol: 0, endRow: 0, endCol: 11 },
    );
    expect(locateTerminalQuote({ buffer: buffer(rows), quote: "error: boom" })?.startRow).toBe(4);
  });

  it("matches a quote that crosses a soft wrap", () => {
    const location = locateTerminalQuote({
      buffer: buffer(["0123456789", { text: "abcdef", wrapped: true }, "next"], 10),
      quote: "789abc",
    });

    expect(location).toEqual({ startRow: 0, startCol: 7, endRow: 1, endCol: 3 });
  });

  it("extends a multi-line quote over the following lines", () => {
    const location = locateTerminalQuote({
      buffer: buffer(["$ make", "cc -o app main.c", "linking app", "$ "]),
      quote: "cc -o app main.c\nlinking app\n",
    });

    expect(location).toEqual({ startRow: 1, startCol: 0, endRow: 2, endCol: 11 });
  });

  it("skips rows before minRow and returns null when the quote is gone", () => {
    const rows = ["needle", "hay", "hay"];

    expect(locateTerminalQuote({ buffer: buffer(rows), quote: "needle", minRow: 1 })).toBeNull();
    expect(locateTerminalQuote({ buffer: buffer(rows), quote: "missing" })).toBeNull();
    expect(locateTerminalQuote({ buffer: buffer(rows), quote: "  \n " })).toBeNull();
  });

  it("uses the buffer's own row numbers", () => {
    const location = locateTerminalQuote({
      buffer: buffer(["first", "second"], 20, 500),
      quote: "second",
    });

    expect(location?.startRow).toBe(501);
  });
});

describe("terminalQuoteRowSpans", () => {
  it("splits a location into per-row column spans", () => {
    expect(terminalQuoteRowSpans({ startRow: 3, startCol: 7, endRow: 5, endCol: 2 }, 10)).toEqual([
      { row: 3, startCol: 7, endCol: 10 },
      { row: 4, startCol: 0, endCol: 10 },
      { row: 5, startCol: 0, endCol: 2 },
    ]);
  });

  it("drops empty rows", () => {
    expect(terminalQuoteRowSpans({ startRow: 0, startCol: 4, endRow: 1, endCol: 0 }, 10)).toEqual([
      { row: 0, startCol: 4, endCol: 10 },
    ]);
  });
});
