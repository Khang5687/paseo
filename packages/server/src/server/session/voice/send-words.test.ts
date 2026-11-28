import { describe, expect, test } from "vitest";

import { isCancelCommand, parseVoiceSendMode, takeOverWord } from "./send-words.js";

describe("takeOverWord", () => {
  test.each([
    ["Fix the login bug, over.", "Fix the login bug"],
    ["Fix the login bug. Over.", "Fix the login bug."],
    ["fix the login bug over", "fix the login bug"],
    ["Run the tests — over!", "Run the tests"],
    ["Over.", ""],
    ["over", ""],
    ["OVER", ""],
  ])("%j ends the message as %j", (transcript, text) => {
    expect(takeOverWord(transcript)).toEqual({ over: true, text });
  });

  test.each([
    "Let's go over the plan.",
    "Go over the plan first",
    "Overall it looks fine.",
    "I have a hangover.",
    "That was a takeover",
    "Over. Then fix the tests.",
    "over and out",
    "Read it over, then commit.",
    "",
  ])("%j is plain text", (transcript) => {
    expect(takeOverWord(transcript)).toEqual({ over: false, text: transcript.trim() });
  });

  test("Vietnamese talk without the English word stays plain text", () => {
    expect(takeOverWord("con agent này fix cái bug đi")).toEqual({
      over: false,
      text: "con agent này fix cái bug đi",
    });
  });
});

describe("isCancelCommand", () => {
  test.each(["cancel", "Cancel.", "Cancel!", "cancel that", "Cancel it.", "Please cancel."])(
    "%j cancels",
    (transcript) => {
      expect(isCancelCommand(transcript)).toBe(true);
    },
  );

  test.each([
    "Cancel the build and restart it.",
    "Don't cancel that.",
    "cancellation policy",
    "can sell",
    "hủy cancel đi",
    "",
  ])("%j is not the command", (transcript) => {
    expect(isCancelCommand(transcript)).toBe(false);
  });
});

describe("parseVoiceSendMode", () => {
  test("only 'over' selects over mode; anything else is auto", () => {
    expect(parseVoiceSendMode("over")).toBe("over");
    expect(parseVoiceSendMode("auto")).toBe("auto");
    expect(parseVoiceSendMode(undefined)).toBe("auto");
    expect(parseVoiceSendMode("push-to-talk")).toBe("auto");
  });
});
