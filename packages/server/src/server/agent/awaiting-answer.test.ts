import { describe, expect, it } from "vitest";
import { replyAwaitsAnswer } from "./awaiting-answer.js";

describe("replyAwaitsAnswer", () => {
  it("is true when any line starts with the question marker", () => {
    expect(replyAwaitsAnswer("❓ Ship it?")).toBe(true);
    expect(replyAwaitsAnswer("Done with the plan.\n\n❓ Q1 storage: SQLite?\n➡️ SQLite")).toBe(
      true,
    );
    expect(replyAwaitsAnswer("Summary\r\n❓ Merge now?\r\n")).toBe(true);
  });

  it("ignores a marker that does not open its line", () => {
    expect(replyAwaitsAnswer("  ❓ indented")).toBe(false);
    expect(replyAwaitsAnswer("- ❓ in a list")).toBe(false);
    expect(replyAwaitsAnswer("> ❓ quoted")).toBe(false);
    expect(replyAwaitsAnswer("Should I ship it ❓")).toBe(false);
  });

  it("ignores ordinary questions and lookalike marks", () => {
    expect(replyAwaitsAnswer("Should I ship it?")).toBe(false);
    expect(replyAwaitsAnswer("? Ship it")).toBe(false);
    expect(replyAwaitsAnswer("❔ Ship it")).toBe(false);
  });

  it("is false without a reply", () => {
    expect(replyAwaitsAnswer(null)).toBe(false);
    expect(replyAwaitsAnswer(undefined)).toBe(false);
    expect(replyAwaitsAnswer("")).toBe(false);
  });
});
