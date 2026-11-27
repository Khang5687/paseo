import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import pino from "pino";
import { describe, expect, test, vi } from "vitest";

import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
} from "../../agent/agent-sdk-types.js";
import type { ManagedAgent } from "../../agent/agent-manager.js";
import type { SessionOutboundMessage } from "../../messages.js";
import type {
  SpeechToTextProvider,
  StreamingTranscriptionSession,
  TextToSpeechProvider,
} from "../../speech/speech-provider.js";
import type {
  TurnDetectionProvider,
  TurnDetectionSession,
} from "../../speech/turn-detection-provider.js";
import { VoiceModeAlreadyActiveError, type VoiceSpeakHandler } from "../../voice-types.js";
import { VoiceSession, type VoiceSessionHost } from "./voice-session.js";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";

class FakeDetector extends EventEmitter implements TurnDetectionSession {
  readonly requiredSampleRate = 16000;
  async connect(): Promise<void> {}
  appendPcm16(): void {}
  flush(): void {}
  reset(): void {}
  close(): void {}
}

class FakeStt extends EventEmitter implements StreamingTranscriptionSession {
  readonly requiredSampleRate = 16000;
  async connect(): Promise<void> {}
  appendPcm16(): void {}
  commit(): void {}
  clear(): void {}
  close(): void {}
}

function setup(options: { registerThrows?: boolean } = {}) {
  const emitted: SessionOutboundMessage[] = [];
  const spokenInput: string[] = [];
  const interrupted: string[] = [];
  const permissionResponses: Array<{ requestId: string; response: AgentPermissionResponse }> = [];
  const synthesized: string[] = [];
  const detector = new FakeDetector();
  const stt = new FakeStt();
  let speakHandler: VoiceSpeakHandler | undefined;

  const tts: TextToSpeechProvider = {
    async synthesizeSpeech(text: string) {
      synthesized.push(text);
      return { stream: Readable.from([Buffer.from("audio")]), format: "pcm;rate=24000" };
    },
  };
  const host: VoiceSessionHost = {
    emit: (message) => {
      emitted.push(message);
      // The client confirms each audio chunk once it has played it.
      if (message.type === "audio_output") {
        queueMicrotask(() => voice.handleAudioPlayed(message.payload.id));
      }
    },
    loadAgent: async (agentId) =>
      ({ id: agentId, config: { systemPrompt: undefined } }) as unknown as ManagedAgent,
    reloadAgentSession: async (agentId) => ({ id: agentId }) as unknown as ManagedAgent,
    respondToPermission: async (_agentId, requestId, response) => {
      permissionResponses.push({ requestId, response });
    },
    sendSpokenInput: async (_agentId, text) => {
      spokenInput.push(text);
    },
    interruptAgentIfRunning: async (agentId) => {
      interrupted.push(agentId);
    },
    hasActiveAgentRun: () => true,
  };
  const voice = new VoiceSession({
    host,
    logger: pino({ level: "silent" }),
    sessionId: "readback-test",
    sttLanguage: "en",
    tts,
    stt: { id: "local", createSession: vi.fn(() => stt) } satisfies SpeechToTextProvider,
    voice: {
      turnDetection: {
        id: "local",
        createSession: vi.fn(() => detector),
      } satisfies TurnDetectionProvider,
    },
    voiceBridge: {
      registerVoiceSpeakHandler: (_id, handler) => {
        if (options.registerThrows) throw new VoiceModeAlreadyActiveError();
        speakHandler = handler;
      },
    },
  });

  /** One finished spoken turn: the user starts talking, stops, and the transcript arrives. */
  async function say(transcript: string): Promise<void> {
    detector.emit("speech_started");
    await settle();
    detector.emit("speech_stopped");
    await settle();
    stt.emit("committed", { segmentId: "s", previousSegmentId: null });
    stt.emit("transcript", {
      segmentId: "s",
      transcript,
      isFinal: true,
      language: "en",
      avgLogprob: -0.1,
      isLowConfidence: false,
    });
    await settle();
  }

  return {
    voice,
    emitted,
    spokenInput,
    interrupted,
    permissionResponses,
    synthesized,
    spoken: () => synthesized.join(" "),
    say,
    speak: (text: string) => {
      if (!speakHandler) throw new Error("speak handler not registered");
      return speakHandler({ text, callerAgentId: AGENT_ID });
    },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

function questionCard(
  id: string,
  questions: Array<{
    question: string;
    header: string;
    options?: string[];
    multiSelect?: boolean;
    allowOther?: boolean;
  }>,
): AgentPermissionRequest {
  return {
    id,
    provider: "claude",
    name: "AskUserQuestion",
    kind: "question",
    input: {
      questions: questions.map((q) => ({
        question: q.question,
        header: q.header,
        options: (q.options ?? []).map((label) => ({ label })),
        multiSelect: q.multiSelect ?? false,
        allowOther: q.allowOther ?? false,
      })),
    },
  };
}

describe("VoiceSession question read-back", () => {
  test("reads a question card word for word and sends the spoken reply as its answer", async () => {
    const t = setup();
    await t.voice.handleSetVoiceMode(true, AGENT_ID);
    const card = questionCard("q1", [
      { question: "Which cache should I use?", header: "Cache", options: ["Redis", "Memcached"] },
    ]);

    t.voice.announcePermissionRequest(AGENT_ID, card);
    await vi.waitFor(() =>
      expect(t.spoken()).toBe("Which cache should I use? Options: Redis. Memcached."),
    );

    await t.say("Let's go with Redis.");

    expect(t.permissionResponses).toEqual([
      {
        requestId: "q1",
        response: {
          behavior: "allow",
          updatedInput: { ...card.input, answers: { Cache: "Redis" } },
        },
      },
    ]);
    expect(t.spokenInput).toEqual([]);
    await t.voice.cleanup();
  });

  test("speaking the answer does not interrupt the run that is waiting on the question", async () => {
    const t = setup();
    await t.voice.handleSetVoiceMode(true, AGENT_ID);
    t.voice.announcePermissionRequest(
      AGENT_ID,
      questionCard("q1", [{ question: "Ship it?", header: "Ship", options: ["Yes", "No"] }]),
    );

    await t.say("yes");

    expect(t.interrupted).toEqual([]);
    expect(t.permissionResponses).toHaveLength(1);
    await t.voice.cleanup();
  });

  test("without a pending question, speaking still interrupts the running agent", async () => {
    const t = setup();
    await t.voice.handleSetVoiceMode(true, AGENT_ID);

    await t.say("stop that");

    expect(t.interrupted).toEqual([AGENT_ID]);
    expect(t.spokenInput).toEqual(["stop that"]);
    await t.voice.cleanup();
  });

  test("reads a card with several questions one at a time and submits all answers together", async () => {
    const t = setup();
    await t.voice.handleSetVoiceMode(true, AGENT_ID);
    const card = questionCard("q2", [
      { question: "Which cache?", header: "Cache", options: ["Redis", "Memcached"] },
      { question: "What should I name it?", header: "Name", allowOther: true },
    ]);

    t.voice.announcePermissionRequest(AGENT_ID, card);
    await vi.waitFor(() =>
      expect(t.spoken()).toBe("Question 1 of 2. Which cache? Options: Redis. Memcached."),
    );

    await t.say("memcached");
    await vi.waitFor(() => expect(t.spoken()).toContain("Question 2 of 2. What should I name it?"));
    expect(t.permissionResponses).toEqual([]);

    await t.say("call it fast cache");
    expect(t.permissionResponses).toEqual([
      {
        requestId: "q2",
        response: {
          behavior: "allow",
          updatedInput: {
            ...card.input,
            answers: { Cache: "Memcached", Name: "call it fast cache" },
          },
        },
      },
    ]);
    await t.voice.cleanup();
  });

  test("an unclear reply re-reads the options and leaves the card open", async () => {
    const t = setup();
    await t.voice.handleSetVoiceMode(true, AGENT_ID);
    t.voice.announcePermissionRequest(
      AGENT_ID,
      questionCard("q1", [{ question: "Ship it?", header: "Ship", options: ["Yes", "No"] }]),
    );
    await vi.waitFor(() => expect(t.spoken()).toBe("Ship it? Options: Yes. No."));

    await t.say("hmm let me think");
    await vi.waitFor(() => expect(t.spoken()).toContain("did not catch which option"));
    expect(t.permissionResponses).toEqual([]);
    expect(t.spokenInput).toEqual([]);
    await t.voice.cleanup();
  });

  test("saying dismiss declines the card", async () => {
    const t = setup();
    await t.voice.handleSetVoiceMode(true, AGENT_ID);
    t.voice.announcePermissionRequest(
      AGENT_ID,
      questionCard("q1", [{ question: "Ship it?", header: "Ship", options: ["Yes", "No"] }]),
    );

    await t.say("dismiss");

    expect(t.permissionResponses).toEqual([
      { requestId: "q1", response: { behavior: "deny", message: "Dismissed by user" } },
    ]);
    await t.voice.cleanup();
  });

  test("a card answered on screen stops taking spoken answers", async () => {
    const t = setup();
    await t.voice.handleSetVoiceMode(true, AGENT_ID);
    t.voice.announcePermissionRequest(
      AGENT_ID,
      questionCard("q1", [{ question: "Ship it?", header: "Ship", options: ["Yes", "No"] }]),
    );

    t.voice.handlePermissionResolved(AGENT_ID, "q1");
    await t.say("yes");

    expect(t.permissionResponses).toEqual([]);
    expect(t.spokenInput).toEqual(["yes"]);
    await t.voice.cleanup();
  });

  test("the same request is read once", async () => {
    const t = setup();
    await t.voice.handleSetVoiceMode(true, AGENT_ID);
    const card = questionCard("q1", [{ question: "Ship it?", header: "Ship", options: ["Yes"] }]);

    t.voice.announcePermissionRequest(AGENT_ID, card);
    t.voice.announcePermissionRequest(AGENT_ID, card);
    await vi.waitFor(() => expect(t.spoken()).toBe("Ship it? Options: Yes."));
    await settle();

    expect(t.spoken()).toBe("Ship it? Options: Yes.");
    await t.voice.cleanup();
  });

  test("reads nothing for an agent that is not in voice mode", async () => {
    const t = setup();

    t.voice.announcePermissionRequest(
      AGENT_ID,
      questionCard("q1", [{ question: "Ship it?", header: "Ship" }]),
    );
    await settle();

    expect(t.synthesized).toEqual([]);
  });
});

describe("VoiceSession permission read-back", () => {
  const bashPrompt = {
    id: "p1",
    provider: "omp",
    name: "bash",
    kind: "tool" as const,
    title: "Allow tool: bash",
    description: "Run the build",
  };

  test("reads the prompt aloud", async () => {
    const t = setup();
    await t.voice.handleSetVoiceMode(true, AGENT_ID);

    t.voice.announcePermissionRequest(AGENT_ID, bashPrompt);

    await vi.waitFor(() =>
      expect(t.spoken()).toBe(
        "Permission needed. Allow tool: bash Run the build Answer it on screen.",
      ),
    );
    await t.voice.cleanup();
  });

  test("speaking while the prompt waits reminds the listener and neither approves it, interrupts the run, nor reaches the agent", async () => {
    const t = setup();
    await t.voice.handleSetVoiceMode(true, AGENT_ID);
    t.voice.announcePermissionRequest(AGENT_ID, bashPrompt);
    await vi.waitFor(() => expect(t.spoken()).toContain("Answer it on screen."));
    const readBack = t.synthesized.length;

    await t.say("yes");

    await vi.waitFor(() =>
      expect(t.synthesized.slice(readBack).join(" ")).toBe(
        "A permission prompt is waiting. Answer it on screen.",
      ),
    );
    expect(t.permissionResponses).toEqual([]);
    expect(t.interrupted).toEqual([]);
    expect(t.spokenInput).toEqual([]);
    await t.voice.cleanup();
  });

  test("once the prompt is answered on screen, speech goes to the agent again", async () => {
    const t = setup();
    await t.voice.handleSetVoiceMode(true, AGENT_ID);
    t.voice.announcePermissionRequest(AGENT_ID, bashPrompt);
    t.voice.handlePermissionResolved(AGENT_ID, bashPrompt.id);

    await t.say("stop that");

    expect(t.interrupted).toEqual([AGENT_ID]);
    expect(t.spokenInput).toEqual(["stop that"]);
    await t.voice.cleanup();
  });
});

describe("VoiceSession speak tool text", () => {
  test("drops code and shortens paths before text-to-speech, and logs the original", async () => {
    const t = setup();
    await t.voice.handleSetVoiceMode(true, AGENT_ID);
    const original =
      "I fixed /home/k/git/paseo/packages/server/src/server/session.ts.\n```ts\nconst a = 1;\n```\nAll tests pass.";

    await t.speak(original);

    expect(t.spoken()).toBe("I fixed session.ts. Code block. All tests pass.");
    expect(t.emitted).toContainEqual(
      expect.objectContaining({
        type: "activity_log",
        payload: expect.objectContaining({ type: "assistant", content: original }),
      }),
    );
    await t.voice.cleanup();
  });

  test("speaks nothing when the text has no speakable words", async () => {
    const t = setup();
    await t.voice.handleSetVoiceMode(true, AGENT_ID);

    await t.speak("   ");

    expect(t.synthesized).toEqual([]);
    await t.voice.cleanup();
  });
});

describe("VoiceSession second device", () => {
  test("a rejected second start carries a code the app can translate", async () => {
    const t = setup({ registerThrows: true });

    await t.voice.handleSetVoiceMode(true, AGENT_ID, "req-1");

    expect(t.emitted).toContainEqual({
      type: "set_voice_mode_response",
      payload: expect.objectContaining({
        requestId: "req-1",
        accepted: false,
        error: "Voice mode is already active for this agent",
        reasonCode: "voice_active_elsewhere",
        retryable: false,
      }),
    });
    await t.voice.cleanup();
  });
});
