import { describe, expect, it } from "vitest";
import { answerTextQuestions, mergeAskedQuestions, parseTextQuestions } from "./text-questions.js";

const AT = "2026-11-27T01:00:00.000Z";
const LATER = "2026-11-27T02:00:00.000Z";

const GRILLING_REPLY = [
  "Two things before I build.",
  "",
  "❓ **Q100** - **Strip icons**: round or square?",
  "Square fits the letter better.",
  "",
  "➡️ square icons with the project letter",
  "",
  "---",
  "",
  "❓ **Q104** - **Sidebar order**: what do I build first?",
  "",
  "➡️ build the project strip first, then last chat,",
  "urgent sort, Opt+Tab, quiet fold",
  "",
  "Goal: ship the sidebar.",
  "Left to do: your answers.",
].join("\n");

describe("parseTextQuestions", () => {
  it("reads label, title, body and the full pick from the grilling format", () => {
    expect(parseTextQuestions(GRILLING_REPLY, AT)).toEqual([
      {
        id: "Q100",
        label: "Q100",
        title: "Strip icons",
        body: "round or square?\nSquare fits the letter better.",
        pick: "square icons with the project letter",
        askedAt: AT,
      },
      {
        id: "Q104",
        label: "Q104",
        title: "Sidebar order",
        body: "what do I build first?",
        pick: "build the project strip first, then last chat,\nurgent sort, Opt+Tab, quiet fold",
        askedAt: AT,
      },
    ]);
  });

  it("accepts looser variants: label inside the bold, no bold, no label, no pick", () => {
    const reply = [
      "❓ **Q7 - Deploy now**: the build is green.",
      "➡️ My pick: yes, deploy",
      "❓ Q8 - Snooze length: until 9:00?",
      "❓ **Which host**: Omen or Mac?",
      "Some detail.",
      "",
      "Goal: something unrelated.",
    ].join("\n");
    const questions = parseTextQuestions(reply, AT);
    expect(
      questions.map(({ id, label, title, body, pick }) => ({ id, label, title, body, pick })),
    ).toEqual([
      {
        id: "Q7",
        label: "Q7",
        title: "Deploy now",
        body: "the build is green.",
        pick: "yes, deploy",
      },
      { id: "Q8", label: "Q8", title: "Snooze length", body: "until 9:00?", pick: null },
      {
        id: "t:which host",
        label: null,
        title: "Which host",
        body: "Omen or Mac?\nSome detail.",
        pick: null,
      },
    ]);
  });

  it("ignores a ❓ that does not start the line", () => {
    expect(parseTextQuestions("I wonder ❓ **Q1** - **x**: y\n  ❓ **Q2** - **z**: w", AT)).toEqual(
      [],
    );
  });
});

describe("mergeAskedQuestions", () => {
  it("replaces a question asked again and keeps the others in asked order", () => {
    const first = parseTextQuestions("❓ **Q1** - **A**: a\n❓ **Q2** - **B**: b", AT);
    const again = parseTextQuestions("❓ **Q1** - **A again**: a2", LATER);
    expect(mergeAskedQuestions(first, again).map((q) => [q.id, q.title])).toEqual([
      ["Q2", "B"],
      ["Q1", "A again"],
    ]);
  });
});

describe("answerTextQuestions", () => {
  const older = parseTextQuestions("❓ **Q1** - **Old**: o\n❓ **Free**: no label", AT);
  const newer = parseTextQuestions("❓ **Q2** - **New**: n\n❓ **Q3** - **Newer**: m", LATER);
  const open = mergeAskedQuestions(older, newer);
  const remaining = (message: string) => answerTextQuestions(open, message).map((q) => q.id);

  it("answers the labels a message names", () => {
    expect(remaining("Q2 (New) yes: the pick\nQ1 round")).toEqual(["Q3"]);
    expect(remaining("q3 a")).toEqual(["Q1", "Q2"]);
  });

  it("answers only the latest reply's questions on a blanket gwr or yes", () => {
    expect(remaining("gwr")).toEqual(["Q1"]);
    expect(remaining("Yes, go ahead")).toEqual(["Q1"]);
    expect(remaining("gwr for all")).toEqual([]);
  });

  it("keeps labelled questions open on a message about something else", () => {
    expect(remaining("Also, can you look at the build log?")).toEqual(["Q1", "Q2", "Q3"]);
    expect(remaining(`yes ${"and a long aside ".repeat(10)}`)).toEqual(["Q1", "Q2", "Q3"]);
  });

  it("answers a question without a label on any message", () => {
    expect(remaining("Also, can you look at the build log?")).not.toContain("t:free");
  });
});
