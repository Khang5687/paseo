import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  CANCELLED_SPEECH,
  NOTHING_TO_CANCEL_SPEECH,
  VOICE_SEND_HOLD_MS,
  VoiceSendGate,
} from "./send-gate.js";
import type { VoiceSendMode } from "./send-words.js";

function createGate(initialMode: VoiceSendMode = "auto") {
  let mode = initialMode;
  const sent: string[] = [];
  const spoken: string[] = [];
  const shortWord: boolean[] = [];
  let cues = 0;
  const gate = new VoiceSendGate({
    getMode: () => mode,
    send: async (text) => {
      sent.push(text);
    },
    playSendCue: () => {
      cues += 1;
    },
    speak: (text) => spoken.push(text),
    setExpectingShortWord: (expecting) => shortWord.push(expecting),
    onSendError: (error) => {
      throw error;
    },
  });
  return {
    gate,
    sent,
    spoken,
    shortWord,
    cues: () => cues,
    setMode: (next: VoiceSendMode) => {
      mode = next;
    },
  };
}

/** What the voice session does with one transcript. */
async function say(gate: VoiceSendGate, transcript: string): Promise<void> {
  gate.handleSpeechStarted();
  if (await gate.settleHeldMessage(transcript)) return;
  await gate.handleUtterance(transcript);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("auto mode", () => {
  test("a finished utterance beeps, waits out the hold, then goes to the agent", async () => {
    const { gate, sent, cues } = createGate();
    await say(gate, "Fix the login bug.");
    expect(cues()).toBe(1);
    expect(sent).toEqual([]);

    await vi.advanceTimersByTimeAsync(VOICE_SEND_HOLD_MS - 1);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual(["Fix the login bug."]);
  });

  test("'cancel' in the hold drops the message and says so", async () => {
    const { gate, sent, spoken } = createGate();
    await say(gate, "Delete the staging database.");
    await vi.advanceTimersByTimeAsync(800);
    await say(gate, "Cancel.");
    await vi.advanceTimersByTimeAsync(VOICE_SEND_HOLD_MS * 2);
    expect(sent).toEqual([]);
    expect(spoken).toEqual([CANCELLED_SPEECH]);
  });

  test("'cancel' still counts when STT finishes after the hold window", async () => {
    const { gate, sent, spoken } = createGate();
    await say(gate, "Deploy to production.");
    await vi.advanceTimersByTimeAsync(1500);
    gate.handleSpeechStarted();
    // Transcription of the speech that started inside the window lands late.
    await vi.advanceTimersByTimeAsync(2000);
    expect(sent).toEqual([]);
    expect(await gate.settleHeldMessage("cancel")).toBe(true);
    expect(sent).toEqual([]);
    expect(spoken).toEqual([CANCELLED_SPEECH]);
  });

  test("noise in the hold does not cancel: the message goes once the window is over", async () => {
    const { gate, sent } = createGate();
    await say(gate, "Run the tests.");
    gate.handleSpeechStarted();
    await vi.advanceTimersByTimeAsync(VOICE_SEND_HOLD_MS + 500);
    expect(sent).toEqual([]);
    expect(await gate.settleHeldMessage("")).toBe(true);
    expect(sent).toEqual(["Run the tests."]);
  });

  test("noise early in the hold leaves the timer to send the message", async () => {
    const { gate, sent } = createGate();
    await say(gate, "Run the tests.");
    gate.handleSpeechStarted();
    expect(await gate.settleHeldMessage("")).toBe(true);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(VOICE_SEND_HOLD_MS);
    expect(sent).toEqual(["Run the tests."]);
  });

  test("new words in the hold send the held message first, then start their own", async () => {
    const { gate, sent, cues } = createGate();
    await say(gate, "Fix the bug.");
    await vi.advanceTimersByTimeAsync(500);
    await say(gate, "And add a test.");
    expect(sent).toEqual(["Fix the bug."]);
    expect(cues()).toBe(2);
    await vi.advanceTimersByTimeAsync(VOICE_SEND_HOLD_MS);
    expect(sent).toEqual(["Fix the bug.", "And add a test."]);
  });

  test("a sentence that only contains 'cancel' is sent as text", async () => {
    const { gate, sent } = createGate();
    await say(gate, "Cancel the build and restart it.");
    await vi.advanceTimersByTimeAsync(VOICE_SEND_HOLD_MS);
    expect(sent).toEqual(["Cancel the build and restart it."]);
  });

  test("'cancel' with nothing pending is not sent to the agent", async () => {
    const { gate, sent, spoken } = createGate();
    await say(gate, "cancel");
    await vi.advanceTimersByTimeAsync(VOICE_SEND_HOLD_MS);
    expect(sent).toEqual([]);
    expect(spoken).toEqual([NOTHING_TO_CANCEL_SPEECH]);
  });

  test("'over' is plain text in auto mode", async () => {
    const { gate, sent } = createGate();
    await say(gate, "Game over.");
    await vi.advanceTimersByTimeAsync(VOICE_SEND_HOLD_MS);
    expect(sent).toEqual(["Game over."]);
  });
});

describe("over mode", () => {
  test("utterances collect until one ends with 'over'; the word is not sent", async () => {
    const { gate, sent, cues } = createGate("over");
    await say(gate, "Fix the login bug.");
    await say(gate, "Then go over the tests.");
    await vi.advanceTimersByTimeAsync(VOICE_SEND_HOLD_MS * 3);
    expect(sent).toEqual([]);
    expect(cues()).toBe(0);

    await say(gate, "And push it, over.");
    expect(cues()).toBe(1);
    await vi.advanceTimersByTimeAsync(VOICE_SEND_HOLD_MS);
    expect(sent).toEqual(["Fix the login bug. Then go over the tests. And push it"]);
  });

  test("a lone 'over' after a pause sends what was said before", async () => {
    const { gate, sent } = createGate("over");
    await say(gate, "Rename the file.");
    await say(gate, "Over.");
    await vi.advanceTimersByTimeAsync(VOICE_SEND_HOLD_MS);
    expect(sent).toEqual(["Rename the file."]);
  });

  test("'over' with nothing said sends nothing", async () => {
    const { gate, sent, cues } = createGate("over");
    await say(gate, "Over.");
    await vi.advanceTimersByTimeAsync(VOICE_SEND_HOLD_MS);
    expect(sent).toEqual([]);
    expect(cues()).toBe(0);
  });

  test("false positives never send", async () => {
    const { gate, sent, cues } = createGate("over");
    for (const words of [
      "Let's go over the plan.",
      "Overall it looks fine.",
      "I have a hangover.",
      "Over. Then fix the tests.",
    ]) {
      await say(gate, words);
    }
    await vi.advanceTimersByTimeAsync(VOICE_SEND_HOLD_MS * 2);
    expect(sent).toEqual([]);
    expect(cues()).toBe(0);
  });

  test("'cancel' before 'over' clears what was said", async () => {
    const { gate, sent, spoken } = createGate("over");
    await say(gate, "Delete everything.");
    await say(gate, "cancel");
    await say(gate, "Keep the backups, over.");
    await vi.advanceTimersByTimeAsync(VOICE_SEND_HOLD_MS);
    expect(spoken).toEqual([CANCELLED_SPEECH]);
    expect(sent).toEqual(["Keep the backups"]);
  });

  test("'cancel' after 'over' drops the message in its hold", async () => {
    const { gate, sent, spoken } = createGate("over");
    await say(gate, "Force push to main, over.");
    await say(gate, "Cancel that.");
    await vi.advanceTimersByTimeAsync(VOICE_SEND_HOLD_MS * 2);
    expect(sent).toEqual([]);
    expect(spoken).toEqual([CANCELLED_SPEECH]);
  });

  test("expects short words while text waits for 'over' and while a message is held", async () => {
    const { gate, shortWord } = createGate("over");
    await say(gate, "Fix the bug.");
    expect(shortWord).toEqual([true]);
    await say(gate, "over");
    expect(shortWord).toEqual([true]);
    await vi.advanceTimersByTimeAsync(VOICE_SEND_HOLD_MS);
    expect(shortWord).toEqual([true, false]);
  });

  test("switching to auto mid-message sends the waiting text with the next utterance", async () => {
    const { gate, sent, setMode } = createGate("over");
    await say(gate, "Fix the bug.");
    setMode("auto");
    await say(gate, "Then run the tests.");
    await vi.advanceTimersByTimeAsync(VOICE_SEND_HOLD_MS);
    expect(sent).toEqual(["Fix the bug. Then run the tests."]);
  });
});

describe("voice turning off", () => {
  test("a held message goes at once; text still waiting for 'over' is dropped", async () => {
    const auto = createGate();
    await say(auto.gate, "Fix the bug.");
    await auto.gate.flush();
    expect(auto.sent).toEqual(["Fix the bug."]);
    await vi.advanceTimersByTimeAsync(VOICE_SEND_HOLD_MS);
    expect(auto.sent).toEqual(["Fix the bug."]);

    const over = createGate("over");
    await say(over.gate, "Half a thought");
    await over.gate.flush();
    expect(over.sent).toEqual([]);
  });
});
