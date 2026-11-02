import { describe, expect, it } from "vitest";

import { createNativeHeadlessTerminal } from "../native-renderer/headless-terminal-state";
import { locateNativeNote, nativeSelectionNoteContext } from "./native-notes";

async function terminalWith(lines: string[], scrollbackLines = 100) {
  const terminal = createNativeHeadlessTerminal({ rows: 4, cols: 20, scrollbackLines });
  await terminal.write(lines.join("\r\n"));
  return terminal;
}

describe("native terminal notes", () => {
  it("reads the selection with rows counted from the oldest kept row", async () => {
    const terminal = await terminalWith(["$ npm test", "PASS src/a.test.ts", "Done"]);
    const { oldestRow, coordinateEpoch } = terminal.getBufferBounds();

    const context = nativeSelectionNoteContext(terminal, {
      start: { row: oldestRow + 1, col: 5 },
      end: { row: oldestRow + 1, col: 17 },
      coordinateEpoch,
    });

    expect(context).toEqual({ text: "src/a.test.ts", startLine: 1, endLine: 1 });
    expect(nativeSelectionNoteContext(terminal, null)).toBeNull();
  });

  it("finds a quote again after scrollback trimmed the rows above it", async () => {
    const lines = Array.from({ length: 30 }, (_, index) => `line ${index}`);
    const terminal = await terminalWith(lines, 10);
    const { oldestRow } = terminal.getBufferBounds();
    // 4 rows + 10 scrollback keep "line 16" .. "line 29".
    expect(oldestRow).toBe(16);

    const location = locateNativeNote(terminal, { quote: "line 25", startLine: 30 });

    expect(location).toEqual({ startRow: 25, startCol: 0, endRow: 25, endCol: 7 });
    // Without a hint the newest match wins ("line 29" contains "line 2").
    expect(locateNativeNote(terminal, { quote: "line 2" })?.startRow).toBe(29);
    expect(locateNativeNote(terminal, { quote: "line 3\nline 4" })).toBeNull();
  });
});
