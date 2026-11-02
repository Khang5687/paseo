import type { IDecoration, IDisposable, IMarker, Terminal } from "@xterm/xterm";
import type { NoteHighlightKind } from "@/notes/model";
import {
  locateTerminalQuote,
  terminalQuoteRowSpans,
  type TerminalQuoteBuffer,
  type TerminalQuoteLocation,
} from "./quote-location";
import type {
  TerminalNoteHighlight,
  TerminalNoteReveal,
  TerminalSelectionAnchor,
  TerminalSelectionNoteContext,
} from "./terminal-note-types";

/**
 * Decorations take only `#rrggbb`, so the tints are fixed hues blended over the terminal's own
 * background. A plain note is a neutral wash, a waiting one amber, a fired one green; xterm draws
 * no underline, so a note resolved by hand is a fainter neutral wash.
 */
const NOTE_TINTS: Record<NoteHighlightKind, { color: string; strength: number }> = {
  open: { color: "#a1a1aa", strength: 0.32 },
  waiting: { color: "#eab308", strength: 0.32 },
  fired: { color: "#22c55e", strength: 0.32 },
  resolved: { color: "#a1a1aa", strength: 0.16 },
};
const FALLBACK_BACKGROUND = "#0b0b0b";
const REFRESH_DELAY_MS = 300;

function xtermQuoteBuffer(terminal: Terminal): TerminalQuoteBuffer {
  const buffer = terminal.buffer.active;
  return {
    firstRow: 0,
    rowCount: buffer.length,
    cols: terminal.cols,
    getRow: (row) => {
      const line = buffer.getLine(row);
      return line ? { text: line.translateToString(true), wrapped: line.isWrapped } : null;
    },
  };
}

export function xtermSelectionNoteContext(terminal: Terminal): TerminalSelectionNoteContext | null {
  if (!terminal.hasSelection()) return null;
  const text = terminal.getSelection().replace(/\s+$/u, "");
  const position = terminal.getSelectionPosition();
  if (!position || text.trim().length === 0) return null;
  // xterm's end column is exclusive: a selection ending at column 0 stops on the row above.
  const endsAtRowStart = position.end.x === 0 && position.end.y > position.start.y;
  return {
    text,
    startLine: position.start.y,
    endLine: endsAtRowStart ? position.end.y - 1 : position.end.y,
  };
}

export function xtermSelectionAnchor(
  terminal: Terminal,
  root: HTMLElement,
): TerminalSelectionAnchor | null {
  const position = terminal.getSelectionPosition();
  const screen = terminal.element?.querySelector(".xterm-screen");
  if (!position || !screen || terminal.cols <= 0 || terminal.rows <= 0) return null;
  const rootRect = root.getBoundingClientRect();
  const grid = screen.getBoundingClientRect();
  const cellWidth = grid.width / terminal.cols;
  const cellHeight = grid.height / terminal.rows;
  const firstRow = terminal.buffer.active.viewportY;
  const gridLeft = grid.left - rootRect.left;
  const gridTop = grid.top - rootRect.top;
  const singleRow = position.start.y === position.end.y;
  return {
    left: gridLeft + (singleRow ? position.start.x : 0) * cellWidth,
    right: gridLeft + (singleRow ? position.end.x : terminal.cols) * cellWidth,
    top: gridTop + (position.start.y - firstRow) * cellHeight,
    bottom: gridTop + (position.end.y - firstRow + 1) * cellHeight,
    width: rootRect.width,
    height: rootRect.height,
  };
}

/** Scroll the quote into view (a third from the top) and select it. */
export function revealXtermNote(terminal: Terminal, input: TerminalNoteReveal): boolean {
  if (terminal.buffer.active.type !== "normal") return false;
  const location = locateTerminalQuote({
    buffer: xtermQuoteBuffer(terminal),
    quote: input.quote,
    hintRow: input.startLine,
  });
  if (!location) return false;
  terminal.scrollToLine(Math.max(0, location.startRow - Math.floor(terminal.rows / 3)));
  const length =
    (location.endRow - location.startRow) * terminal.cols + location.endCol - location.startCol;
  terminal.select(location.startCol, location.startRow, Math.max(1, length));
  return true;
}

function parseHexColor(value: string | undefined): [number, number, number] | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/iu.exec(value?.trim() ?? "")?.[1];
  if (!hex) return null;
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((digit) => digit + digit)
          .join("")
      : hex;
  return [0, 2, 4].map((index) => Number.parseInt(full.slice(index, index + 2), 16)) as [
    number,
    number,
    number,
  ];
}

/** `tint` laid over `background` at `strength`, as `#rrggbb` (decorations take only that). */
function blendTint(background: string | undefined, tint: string, strength: number): string {
  const base = parseHexColor(background) ?? parseHexColor(FALLBACK_BACKGROUND)!;
  const over = parseHexColor(tint)!;
  return `#${base
    .map((channel, index) =>
      Math.round(channel + (over[index]! - channel) * strength)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

interface DrawnHighlight {
  quote: string;
  kind: NoteHighlightKind;
  markers: IMarker[];
  decorations: IDecoration[];
}

function disposeDrawn(drawn: DrawnHighlight): void {
  for (const decoration of drawn.decorations) decoration.dispose();
  for (const marker of drawn.markers) marker.dispose();
}

/**
 * Draws notes over their quotes with xterm decorations. Decorations ride markers, so they follow
 * output and scrollback trimming; a refresh only searches for notes that are not drawn yet.
 * A note that was not found is searched again only in rows written since the last refresh.
 */
export class XtermNoteHighlights {
  private wanted = new Map<string, TerminalNoteHighlight>();
  private readonly drawn = new Map<string, DrawnHighlight>();
  private readonly missing = new Set<string>();
  /** First row not yet searched for missing notes (the cursor row at the last refresh). */
  private scanMarker: IMarker | undefined;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly resizeSubscription: IDisposable;

  constructor(
    private readonly terminal: Terminal,
    private background: string | undefined,
  ) {
    // Reflow moves quotes to other columns; markers only follow rows.
    this.resizeSubscription = terminal.onResize(() => {
      this.clearDrawn();
      this.schedule();
    });
  }

  set(highlights: readonly TerminalNoteHighlight[]): void {
    this.wanted = new Map(highlights.map((highlight) => [highlight.id, highlight]));
    this.refresh();
  }

  setBackground(background: string | undefined): void {
    if (background === this.background) return;
    this.background = background;
    this.clearDrawn();
    this.refresh();
  }

  /** Debounced refresh after output or scrolling. */
  schedule(): void {
    if (this.timer !== null || this.wanted.size === 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.refresh();
    }, REFRESH_DELAY_MS);
  }

  dispose(): void {
    this.resizeSubscription.dispose();
    clearTimeout(this.timer ?? undefined);
    this.timer = null;
    this.clearDrawn();
    this.scanMarker?.dispose();
    this.scanMarker = undefined;
  }

  private clearDrawn(): void {
    for (const drawn of this.drawn.values()) disposeDrawn(drawn);
    this.drawn.clear();
    this.missing.clear();
  }

  private refresh(): void {
    const terminal = this.terminal;
    // Decorations only exist on the normal buffer; output there schedules the next refresh.
    if (terminal.buffer.active.type !== "normal") return;

    this.dropStale();
    if (this.wanted.size === 0) {
      this.scanMarker?.dispose();
      this.scanMarker = undefined;
      return;
    }
    this.drawMissing();
    this.scanMarker?.dispose();
    this.scanMarker = terminal.registerMarker(0);
  }

  /** Dispose highlights that were removed, changed, or lost their rows. */
  private dropStale(): void {
    for (const [id, drawn] of this.drawn) {
      const wanted = this.wanted.get(id);
      const live = drawn.markers.length > 0 && drawn.markers.every((marker) => !marker.isDisposed);
      if (wanted && live && wanted.quote === drawn.quote && wanted.kind === drawn.kind) continue;
      disposeDrawn(drawn);
      this.drawn.delete(id);
    }
    for (const id of this.missing) {
      if (!this.wanted.has(id)) this.missing.delete(id);
    }
  }

  private drawMissing(): void {
    const scanFrom =
      this.scanMarker && !this.scanMarker.isDisposed ? Math.max(0, this.scanMarker.line) : 0;
    let buffer: TerminalQuoteBuffer | null = null;
    for (const highlight of this.wanted.values()) {
      if (this.drawn.has(highlight.id)) continue;
      buffer ??= xtermQuoteBuffer(this.terminal);
      const location = locateTerminalQuote({
        buffer,
        quote: highlight.quote,
        hintRow: highlight.startLine,
        minRow: this.missing.has(highlight.id) ? scanFrom : 0,
      });
      const drawn = location ? this.draw(highlight, location) : null;
      if (drawn) {
        this.drawn.set(highlight.id, drawn);
        this.missing.delete(highlight.id);
      } else {
        this.missing.add(highlight.id);
      }
    }
  }

  private draw(
    highlight: TerminalNoteHighlight,
    location: TerminalQuoteLocation,
  ): DrawnHighlight | null {
    const terminal = this.terminal;
    const buffer = terminal.buffer.active;
    const cursorRow = buffer.baseY + buffer.cursorY;
    const tint = NOTE_TINTS[highlight.kind];
    const backgroundColor = blendTint(this.background, tint.color, tint.strength);
    const drawn: DrawnHighlight = {
      quote: highlight.quote,
      kind: highlight.kind,
      markers: [],
      decorations: [],
    };
    for (const span of terminalQuoteRowSpans(location, terminal.cols)) {
      const marker = terminal.registerMarker(span.row - cursorRow);
      if (!marker) continue;
      drawn.markers.push(marker);
      const decoration = terminal.registerDecoration({
        marker,
        x: span.startCol,
        width: span.endCol - span.startCol,
        backgroundColor,
        layer: "bottom",
        ...(drawn.decorations.length === 0
          ? { overviewRulerOptions: { color: tint.color, position: "full" as const } }
          : {}),
      });
      if (decoration) drawn.decorations.push(decoration);
    }
    if (drawn.decorations.length === 0) {
      disposeDrawn(drawn);
      return null;
    }
    return drawn;
  }
}
