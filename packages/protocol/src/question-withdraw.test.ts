import { describe, expect, it } from "vitest";
import { parseWithdrawLine } from "./question-withdraw.js";

describe("parseWithdrawLine", () => {
  it("reads a ✖️ line at a line start, with or without the arrow, bold or plain", () => {
    const lines = [
      '✖️ Q630 → Q653: folded into "When the pause ends"',
      "✖️ Q640: dropped, no longer needed",
      "✖ **Q641** -> **Q653**: folded",
      "✖️ q642",
      "- ✖️ Q643: a bullet is prose",
      "I withdraw ✖️ Q644 here too.",
      "✖️ no label: ignored",
    ];
    expect(lines.map(parseWithdrawLine)).toEqual([
      { label: "Q630", replacedBy: "Q653" },
      { label: "Q640", replacedBy: null },
      { label: "Q641", replacedBy: "Q653" },
      { label: "Q642", replacedBy: null },
      null,
      null,
      null,
    ]);
  });
});
