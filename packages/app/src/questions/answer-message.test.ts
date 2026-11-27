import { describe, expect, it } from "vitest";
import type { AgentOpenQuestion, AgentQuestionAnswer } from "@getpaseo/protocol/messages";
import { buildAnswerMessage, buildCopyAnswersText, resolveAnswer } from "./answer-message";

function question(
  id: string,
  title: string,
  pick: string | null,
  label: string | null = id,
): AgentOpenQuestion {
  return { id, label, title, body: "", pick, askedAt: "2026-11-27T00:00:00.000Z" };
}

const questions = [
  question("Q100", "Strip icons", "square icons with the project letter"),
  question("Q101", "Needs you icon", "top of the rail"),
  question("Q104", "Sidebar order", "newest first"),
];

describe("buildAnswerMessage", () => {
  it("writes one line per answered card with the title and the pick's own words", () => {
    const answers: Record<string, AgentQuestionAnswer> = {
      Q100: { pick: false, text: "round, like the avatars", updatedAt: 1 },
      Q104: {
        pick: true,
        text: "",
        updatedAt: 1,
        files: [{ id: "u1", fileName: "order.png", mimeType: "image/png", size: 3, path: "/u1" }],
      },
    };
    const message = buildAnswerMessage(questions, (entry) => answers[entry.id]);
    expect(message?.text).toBe(
      [
        "Q100 (Strip icons) round, like the avatars",
        "Q104 (Sidebar order) yes: newest first [files: order.png]",
      ].join("\n"),
    );
    // The skipped card stays open: the message does not name it.
    expect(message?.questionIds).toEqual(["Q100", "Q104"]);
    expect(message?.files.map((file) => file.id)).toEqual(["u1"]);
  });

  it("sends nothing while no card is answered, and treats blank text as unanswered", () => {
    expect(
      buildAnswerMessage(questions, () => ({ pick: false, text: "  ", updatedAt: 1 })),
    ).toBeNull();
  });

  it("names a question without a label by its title", () => {
    const message = buildAnswerMessage([question("ship-it", "Ship it", null, null)], () => ({
      pick: true,
      text: "",
      updatedAt: 1,
    }));
    expect(message?.text).toBe("(Ship it) yes");
  });
});

describe("buildCopyAnswersText", () => {
  const answers: Record<string, AgentQuestionAnswer> = {
    Q100: { pick: false, text: "round, like the avatars", updatedAt: 1 },
    Q104: { pick: true, text: "", updatedAt: 1 },
    Q200: { pick: true, text: "", updatedAt: 1 },
  };
  const answerFor = (entry: AgentOpenQuestion) => answers[entry.id];

  it("puts each chat's own lines under its title, in order, and leaves out unanswered chats", () => {
    const other = [question("Q200", "Beta layout", "grid")];
    expect(
      buildCopyAnswersText([
        { title: "Alpha chat", messages: [buildAnswerMessage(questions, answerFor)] },
        { title: "Quiet chat", messages: [buildAnswerMessage(other, () => undefined)] },
        { title: "Beta chat", messages: [buildAnswerMessage(other, answerFor)] },
      ]),
    ).toBe(
      [
        "Alpha chat",
        "Q100 (Strip icons) round, like the avatars",
        "Q104 (Sidebar order) yes: newest first",
        "",
        "Beta chat",
        "Q200 (Beta layout) yes: grid",
      ].join("\n"),
    );
  });

  it("is null while nothing is answered", () => {
    expect(buildCopyAnswersText([{ title: "Alpha chat", messages: [null] }])).toBeNull();
    expect(buildCopyAnswersText([])).toBeNull();
  });
});

describe("resolveAnswer", () => {
  it("keeps the newer of this device's answer and the host's", () => {
    const local = { pick: true, text: "", updatedAt: 5 };
    const remote = { pick: false, text: "from the phone", updatedAt: 9 };
    expect(resolveAnswer(local, remote)).toBe(remote);
    expect(resolveAnswer({ ...local, updatedAt: 10 }, remote)?.pick).toBe(true);
    expect(resolveAnswer(undefined, remote)).toBe(remote);
  });
});
