import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import { findQuestionMessageId, splitWithdrawnLines } from "./withdrawn-lines";

describe("splitWithdrawnLines", () => {
  it("turns ✖️ lines into withdrawn segments and keeps the Markdown around them", () => {
    const reply = [
      "Folding the pause questions.",
      "",
      '✖️ Q630 → Q653: folded into "When the pause ends"',
      "✖️ Q640: dropped, no longer needed",
      "",
      "❓ **Q653** - **When the pause ends**: resume at once?",
    ].join("\n");
    expect(splitWithdrawnLines(reply, false)).toEqual([
      { kind: "markdown", text: "Folding the pause questions." },
      {
        kind: "withdrawn",
        questions: [
          { label: "Q630", replacedBy: "Q653" },
          { label: "Q640", replacedBy: null },
        ],
      },
      { kind: "markdown", text: "❓ **Q653** - **When the pause ends**: resume at once?" },
    ]);
  });

  it("leaves a ✖️ inside a code fence, after a bullet, or on a streaming last line as Markdown", () => {
    const fenced = ["```", "✖️ Q630: dropped", "```"].join("\n");
    expect(splitWithdrawnLines(fenced, false)).toEqual([{ kind: "markdown", text: fenced }]);
    expect(splitWithdrawnLines("- ✖️ Q630: dropped", false)).toEqual([
      { kind: "markdown", text: "- ✖️ Q630: dropped" },
    ]);
    expect(splitWithdrawnLines("Done.\n✖️ Q6", true)).toEqual([
      { kind: "markdown", text: "Done.\n✖️ Q6" },
    ]);
    expect(splitWithdrawnLines("Done.\n✖️ Q630: dropped\n", true)).toEqual([
      { kind: "markdown", text: "Done." },
      { kind: "withdrawn", questions: [{ label: "Q630", replacedBy: null }] },
    ]);
  });
});

describe("findQuestionMessageId", () => {
  const reply = (id: string, text: string, at: number): StreamItem => ({
    kind: "assistant_message",
    id,
    text,
    timestamp: new Date(at),
  });

  it("finds the newest reply that asks the label with a ❓ line", () => {
    const items = [
      reply("late", "❓ **Q653** - **Pause**: asked again", 3),
      reply("early", "❓ **Q653** - **Pause**: first ask", 1),
      reply("mention", "✖️ Q630 → Q653: folded, see Q653", 4),
    ];
    expect(findQuestionMessageId(items, "Q653")).toBe("late");
    expect(findQuestionMessageId(items, "Q65")).toBeNull();
  });
});
