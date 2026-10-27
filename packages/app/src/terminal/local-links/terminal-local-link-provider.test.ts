import type { IBufferCell, Terminal } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";
import {
  createTerminalLocalFileLinkProvider,
  isBufferCellInRange,
} from "./terminal-local-link-provider";

describe("createTerminalLocalFileLinkProvider", () => {
  it("resolves before exposing a local file link", async () => {
    const terminal = createTerminal(["file.ts:42"]);
    const resolveLink = vi.fn(async () => ({ path: "/repo/src/file.ts", lineStart: 42 }));
    const openLink = vi.fn();
    const provider = createTerminalLocalFileLinkProvider(terminal, { resolveLink, openLink });

    const links = await provideLinks(provider, 1);

    expect(resolveLink).toHaveBeenCalledWith({
      text: "file.ts:42",
      path: "file.ts",
      lineStart: 42,
    });
    expect(links).toHaveLength(1);
    expect(links?.[0]?.text).toBe("file.ts:42");
  });

  it("decorates the full parsed link span", async () => {
    const terminal = createTerminal(["echo README.md:5"]);
    const provider = createTerminalLocalFileLinkProvider(terminal, {
      resolveLink: vi.fn(async () => ({ path: "/repo/README.md", lineStart: 5 })),
      openLink: vi.fn(),
    });

    const [link] = (await provideLinks(provider, 1)) ?? [];

    expect(link?.range).toEqual({
      start: { x: 6, y: 1 },
      end: { x: 16, y: 1 },
    });
  });

  it("opens resolved links with assistant-style disposition semantics", async () => {
    const terminal = createTerminal(["src/file.ts:42"]);
    const target = { path: "/repo/src/file.ts", lineStart: 42 };
    const openLink = vi.fn();
    const provider = createTerminalLocalFileLinkProvider(terminal, {
      resolveLink: vi.fn(async () => target),
      openLink,
    });

    const [link] = (await provideLinks(provider, 1)) ?? [];
    link?.activate(
      { preventDefault: vi.fn(), button: 0, ctrlKey: true } as unknown as MouseEvent,
      link.text,
    );

    expect(openLink).toHaveBeenCalledWith(target, "side", expect.anything());
  });

  it("leaves a right click to the file menu instead of opening the file", async () => {
    const terminal = createTerminal(["src/file.ts:42"]);
    const openLink = vi.fn();
    const provider = createTerminalLocalFileLinkProvider(terminal, {
      resolveLink: vi.fn(async () => ({ path: "/repo/src/file.ts", lineStart: 42 })),
      openLink,
    });

    const [link] = (await provideLinks(provider, 1)) ?? [];
    link?.activate({ preventDefault: vi.fn(), button: 2 } as unknown as MouseEvent, link.text);

    expect(openLink).not.toHaveBeenCalled();
  });

  it("does not expose unresolved candidates as links", async () => {
    const terminal = createTerminal(["missing.ts:42"]);
    const provider = createTerminalLocalFileLinkProvider(terminal, {
      resolveLink: vi.fn(async () => null),
      openLink: vi.fn(),
    });

    await expect(provideLinks(provider, 1)).resolves.toBeUndefined();
  });

  it("places a cell inside a link range, including a range that wraps onto the next row", () => {
    const range = { start: { x: 70, y: 4 }, end: { x: 6, y: 5 } };

    expect(isBufferCellInRange({ x: 70, y: 4 }, range)).toBe(true);
    expect(isBufferCellInRange({ x: 1, y: 5 }, range)).toBe(true);
    expect(isBufferCellInRange({ x: 6, y: 5 }, range)).toBe(true);
    expect(isBufferCellInRange({ x: 69, y: 4 }, range)).toBe(false);
    expect(isBufferCellInRange({ x: 7, y: 5 }, range)).toBe(false);
    expect(isBufferCellInRange({ x: 1, y: 6 }, range)).toBe(false);
  });
});

function provideLinks(
  provider: ReturnType<typeof createTerminalLocalFileLinkProvider>,
  bufferLineNumber: number,
) {
  return new Promise<Parameters<Parameters<typeof provider.provideLinks>[1]>[0]>((resolve) => {
    provider.provideLinks(bufferLineNumber, resolve);
  });
}

function createTerminal(lines: string[]): Terminal {
  const bufferLines = lines.map((line) => new FakeBufferLine(line));
  return {
    cols: 80,
    buffer: {
      active: {
        length: bufferLines.length,
        getLine: (index: number) => bufferLines[index],
        getNullCell: () => new FakeBufferCell(""),
      },
    },
  } as unknown as Terminal;
}

class FakeBufferLine {
  readonly isWrapped = false;
  readonly length: number;

  constructor(private readonly text: string) {
    this.length = text.length;
  }

  getCell(x: number, cell?: IBufferCell): IBufferCell | undefined {
    const value = this.text[x] ?? "";
    if (cell instanceof FakeBufferCell) {
      cell.setValue(value);
      return cell as unknown as IBufferCell;
    }
    return new FakeBufferCell(value) as unknown as IBufferCell;
  }

  translateToString(): string {
    return this.text;
  }
}

class FakeBufferCell {
  constructor(private value: string) {}

  setValue(value: string): void {
    this.value = value;
  }

  getChars(): string {
    return this.value;
  }

  getWidth(): number {
    return this.value ? 1 : 0;
  }

  getCode(): number {
    return this.value.codePointAt(0) ?? 0;
  }

  getFgColorMode(): number {
    return 0;
  }

  getBgColorMode(): number {
    return 0;
  }

  getFgColor(): number {
    return 0;
  }

  getBgColor(): number {
    return 0;
  }

  isAttributeDefault(): boolean {
    return true;
  }

  isFgDefault(): boolean {
    return true;
  }

  isBgDefault(): boolean {
    return true;
  }

  isFgRGB(): boolean {
    return false;
  }

  isBgRGB(): boolean {
    return false;
  }

  isFgPalette(): boolean {
    return false;
  }

  isBgPalette(): boolean {
    return false;
  }

  isBold(): boolean {
    return false;
  }

  isItalic(): boolean {
    return false;
  }

  isDim(): boolean {
    return false;
  }

  isUnderline(): boolean {
    return false;
  }

  isBlink(): boolean {
    return false;
  }

  isInverse(): boolean {
    return false;
  }

  isInvisible(): boolean {
    return false;
  }

  isStrikethrough(): boolean {
    return false;
  }

  isOverline(): boolean {
    return false;
  }
}
