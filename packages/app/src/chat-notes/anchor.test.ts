import { describe, expect, it } from "vitest";
import { joinedOffset, locateQuote, nodeAtOffset, noteFindQuery } from "./anchor";

describe("locateQuote", () => {
  const text = "alpha beta gamma beta delta";

  it("keeps stored offsets that still cover the quote", () => {
    expect(locateQuote(text, "beta", { start: 17, end: 21 })).toEqual({ start: 17, end: 21 });
  });

  it("picks the occurrence nearest stale offsets", () => {
    expect(locateQuote(text, "beta", { start: 15, end: 19 })).toEqual({ start: 17, end: 21 });
    expect(locateQuote(text, "beta", { start: 4, end: 8 })).toEqual({ start: 6, end: 10 });
  });

  it("takes the first occurrence without offsets", () => {
    expect(locateQuote(text, "beta")).toEqual({ start: 6, end: 10 });
  });

  it("matches a quote across block breaks the rendered text joins without whitespace", () => {
    const rendered = "First paragraph.Second paragraph.";
    expect(locateQuote(rendered, "paragraph.\n\nSecond")).toEqual({ start: 6, end: 22 });
  });

  it("treats regular expression characters literally", () => {
    expect(locateQuote("call fn(a+b) now", "fn(a+b)")).toEqual({ start: 5, end: 12 });
  });

  it("returns null when the quote is gone or empty", () => {
    expect(locateQuote(text, "omega", { start: 0, end: 5 })).toBeNull();
    expect(locateQuote(text, "  \n ")).toBeNull();
  });

  it("ignores offsets past the end of the text", () => {
    expect(locateQuote("short beta", "beta", { start: 40, end: 44 })).toEqual({
      start: 6,
      end: 10,
    });
  });
});

describe("joinedOffset and nodeAtOffset", () => {
  const lengths = [5, 0, 3, 4];

  it("turns a node boundary into a joined offset", () => {
    expect(joinedOffset(lengths, 0, 2)).toBe(2);
    expect(joinedOffset(lengths, 2, 1)).toBe(6);
    expect(joinedOffset(lengths, 3, 99)).toBe(12);
    expect(joinedOffset(lengths, 4, 0)).toBe(12);
  });

  it("maps a joined offset back to the node that holds it", () => {
    expect(nodeAtOffset(lengths, 6, "start")).toEqual({ index: 2, offset: 1 });
    // A boundary between nodes starts the next node and ends the previous one.
    expect(nodeAtOffset(lengths, 5, "start")).toEqual({ index: 2, offset: 0 });
    expect(nodeAtOffset(lengths, 5, "end")).toEqual({ index: 0, offset: 5 });
    expect(nodeAtOffset(lengths, 12, "end")).toEqual({ index: 3, offset: 4 });
    expect(nodeAtOffset(lengths, 12, "start")).toBeNull();
  });
});

describe("noteFindQuery", () => {
  it("uses the first non-empty line of a quote", () => {
    expect(noteFindQuery("\n  first line  \nsecond line")).toBe("first line");
  });

  it("cuts a long line at a word boundary", () => {
    const quote = "word ".repeat(30).trim();
    const query = noteFindQuery(quote, 20);
    expect(query.length).toBeLessThanOrEqual(20);
    expect(query.endsWith("word")).toBe(true);
  });
});
