import { Readable } from "node:stream";
import type { VoiceSpeakHandler } from "../../voice-types.js";
import { EventEmitter } from "node:events";
import pino from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

import { VoiceSession, type VoiceArrival, type VoiceSessionHost } from "./voice-session.js";
import { SHORT_WORD_CONFIRM_MS, VOICE_SEND_HOLD_MS } from "./send-gate.js";
import type { VoiceSendMode } from "./send-words.js";
import type { VoiceChatProject } from "@getpaseo/protocol/voice/chat-directory";
import { findHostMatches, type VoiceHostChats } from "@getpaseo/protocol/voice/chat-match";
import {
  createVoiceNavMemory,
  type VoiceFindChatsAnswer,
  type VoiceFindChatsQuery,
  type VoiceNavMemory,
} from "./voice-navigate.js";
import { SIDE_HELPER_TIMEOUT_MS, SIDE_HELPER_WAIT_MS } from "./voice-side-helper.js";
import type { ManagedAgent } from "../../agent/agent-manager.js";
import type { AgentSessionConfig } from "../../agent/agent-sdk-types.js";
import type { SessionOutboundMessage } from "../../messages.js";
import type {
  SpeechToTextProvider,
  TextToSpeechProvider,
  StreamingTranscriptionCommittedEvent,
  StreamingTranscriptionEvent,
  StreamingTranscriptionSession,
} from "../../speech/speech-provider.js";
import type {
  TurnDetectionProvider,
  TurnDetectionSession,
} from "../../speech/turn-detection-provider.js";

const VOICE_AGENT_ID = "11111111-1111-4111-8111-111111111111";

class FakeVoiceTurnDetectionSession extends EventEmitter implements TurnDetectionSession {
  public readonly requiredSampleRate = 16000;

  async connect(): Promise<void> {}

  appendPcm16(_chunk: Buffer): void {}

  flush(): void {}
  readonly confirmWindows: Array<number | null> = [];
  setSpeechConfirmMs(ms: number | null): void {
    this.confirmWindows.push(ms);
  }
  reset(): void {}
  close(): void {}
}

class FakeVoiceSttSession extends EventEmitter implements StreamingTranscriptionSession {
  public readonly requiredSampleRate = 16000;
  public commitCount = 0;

  async connect(): Promise<void> {}

  appendPcm16(_pcm16le: Buffer): void {}

  commit(): void {
    this.commitCount += 1;
  }

  clear(): void {}
  close(): void {}

  emitCommitted(event: StreamingTranscriptionCommittedEvent): void {
    this.emit("committed", event);
  }

  emitTranscript(event: StreamingTranscriptionEvent): void {
    this.emit("transcript", event);
  }
}

interface FakeVoiceHost extends VoiceSessionHost {
  readonly emitted: SessionOutboundMessage[];
  readonly spokenInput: Array<{ agentId: string; text: string }>;
  readonly reloadedAgentIds: string[];
  speakUnavailable: string | null;
  readonly speakToolReady: boolean[];
  readonly reloads: Array<Partial<AgentSessionConfig>>;
  /** Starts or ends the agent's run; ending it releases every waitForAgentIdle. */
  setRunActive(active: boolean): void;
  /** What `listVoiceChats` returns. */
  chats: VoiceChatProject[];
}

function createFakeHost(): FakeVoiceHost {
  const emitted: SessionOutboundMessage[] = [];
  const spokenInput: Array<{ agentId: string; text: string }> = [];
  const reloadedAgentIds: string[] = [];
  const speakToolReady: boolean[] = [];
  const reloads: Array<Partial<AgentSessionConfig>> = [];
  const idleWaiters: Array<() => void> = [];
  let runActive = false;
  const host: FakeVoiceHost = {
    emitted,
    spokenInput,
    reloadedAgentIds,
    speakUnavailable: null,
    speakToolReady,
    reloads,
    setRunActive: (active) => {
      runActive = active;
      if (!active) for (const release of idleWaiters.splice(0)) release();
    },
    emit: (msg) => {
      emitted.push(msg);
    },
    loadAgent: async (agentId) =>
      ({
        id: agentId,
        provider: "omp",
        config: { systemPrompt: undefined },
      }) as unknown as ManagedAgent,
    speakToolUnavailableReason: () => host.speakUnavailable,
    reloadAgentSession: async (agentId, overrides) => {
      reloadedAgentIds.push(agentId);
      reloads.push(overrides);
      return { id: agentId } as unknown as ManagedAgent;
    },
    respondToPermission: async () => {},
    sendSpokenInput: async (agentId, text, options) => {
      spokenInput.push({ agentId, text });
      speakToolReady.push(options.speakToolReady);
    },
    interruptAgentIfRunning: vi.fn(async () => {}),
    hasActiveAgentRun: () => runActive,
    waitForAgentIdle: (_agentId, signal) =>
      new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
        signal?.addEventListener("abort", () => resolve(), { once: true });
      }),
    chats: [],
    listVoiceChats: async () => host.chats,
  };
  return host;
}

function createVoiceSession(
  tts: TextToSpeechProvider | null = null,
  options: { sendMode?: () => VoiceSendMode; navMemory?: VoiceNavMemory } = {},
) {
  let speakHandler: VoiceSpeakHandler | undefined;
  const detector = new FakeVoiceTurnDetectionSession();
  const sttSession = new FakeVoiceSttSession();
  const stt: SpeechToTextProvider = {
    id: "local",
    createSession: vi.fn(() => sttSession),
  };
  const turnDetection: TurnDetectionProvider = {
    id: "local",
    createSession: vi.fn(() => detector),
  };
  const host = createFakeHost();
  const voiceSession = new VoiceSession({
    host,
    logger: pino({ level: "silent" }),
    sessionId: "voice-session-test",
    sttLanguage: "en",
    tts,
    voiceBridge: {
      registerVoiceSpeakHandler: (_id, handler) => {
        speakHandler = handler;
      },
    },
    stt,
    voice: { turnDetection, sendMode: options.sendMode },
    navMemory: options.navMemory,
  });
  return {
    voiceSession,
    detector,
    sttSession,
    host,
    speak: (args: Parameters<VoiceSpeakHandler>[0]) => {
      if (!speakHandler) throw new Error("Voice speak handler not registered");
      return speakHandler(args);
    },
  };
}

function isAudioOutput(message: SessionOutboundMessage): boolean {
  return message.type === "audio_output";
}

/** A TTS whose clips the tests play back at once (see `acknowledgeAudio`). */
const playedTts: TextToSpeechProvider = {
  async synthesizeSpeech() {
    return { stream: Readable.from([Buffer.from("audio")]), format: "pcm;rate=24000" };
  },
};

/** Plays every audio clip at once, as an app would after hearing it. */
function acknowledgeAudio(setup: ReturnType<typeof createVoiceSession>): void {
  const emit = setup.host.emit;
  setup.host.emit = (message) => {
    emit(message);
    if (message.type === "audio_output") setup.voiceSession.handleAudioPlayed(message.payload.id);
  };
}

function spokenAnnouncements(host: FakeVoiceHost): string[] {
  return host.emitted.flatMap((message) =>
    message.type === "activity_log" && message.payload.type === "assistant"
      ? [message.payload.content]
      : [],
  );
}
async function waitForAudioOutput(host: FakeVoiceHost): Promise<void> {
  await vi.waitFor(() => expect(host.emitted.filter(isAudioOutput)).toHaveLength(1));
}

/**
 * Lets the turn controller's serial queue drain. The fake STT answers at once, so a turn must not
 * emit its transcript before the previous turn's handling (and its speech_stopped) has run.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

/** One spoken turn through the fake detector and STT, ending with a final transcript. */
async function sayTurn(
  detector: FakeVoiceTurnDetectionSession,
  sttSession: FakeVoiceSttSession,
  transcript: string,
  segmentId: string,
): Promise<void> {
  detector.emit("speech_started");
  await settle();
  detector.emit("speech_stopped");
  await settle();
  sttSession.emitCommitted({ segmentId, previousSegmentId: null });
  sttSession.emitTranscript({
    segmentId,
    transcript,
    isFinal: true,
    avgLogprob: -0.1,
    isLowConfidence: false,
  });
  await settle();
}

describe("VoiceSession streaming transcription", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("speech detection stops playback but leaves the agent's run alone", async () => {
    const tts: TextToSpeechProvider = {
      async synthesizeSpeech() {
        return { stream: Readable.from([Buffer.from("audio")]), format: "pcm;rate=24000" };
      },
    };
    const { voiceSession, detector, host, speak } = createVoiceSession(tts);
    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
    host.setRunActive(true);
    const playback = speak({ text: "A spoken response." });
    try {
      await waitForAudioOutput(host);
      detector.emit("speech_started");
      await settle();
      expect(host.emitted).toContainEqual({
        type: "voice_input_state",
        payload: { isSpeaking: true },
      });
      // Playback only resolves once the client confirms it or it is cancelled.
      await playback;
      expect(host.interruptAgentIfRunning).not.toHaveBeenCalled();
    } finally {
      await voiceSession.cleanup();
      await playback.catch(() => {});
    }
  });

  test("an explicit abort request stops playback and interrupts the agent's run", async () => {
    const tts: TextToSpeechProvider = {
      async synthesizeSpeech() {
        return { stream: Readable.from([Buffer.from("audio")]), format: "pcm;rate=24000" };
      },
    };
    const { voiceSession, host, speak } = createVoiceSession(tts);
    host.interruptAgentIfRunning = vi.fn(async () => {});
    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
    const playback = speak({ text: "A spoken response." });
    try {
      await waitForAudioOutput(host);
      await voiceSession.handleAbort();
      await playback;
      expect(host.interruptAgentIfRunning).toHaveBeenCalledWith(VOICE_AGENT_ID);
    } finally {
      await voiceSession.cleanup();
      await playback.catch(() => {});
    }
  });

  test("a spoken turn during a run reaches the agent without interrupting it", async () => {
    vi.useFakeTimers();
    const { voiceSession, detector, sttSession, host } = createVoiceSession();
    host.interruptAgentIfRunning = vi.fn(async () => {});

    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
    host.setRunActive(true);
    detector.emit("speech_started");
    await settle();
    detector.emit("speech_stopped");
    await settle();
    sttSession.emitCommitted({ segmentId: "segment-1", previousSegmentId: null });
    sttSession.emitTranscript({
      segmentId: "segment-1",
      transcript: "also check the logs",
      isFinal: true,
      avgLogprob: -0.1,
      isLowConfidence: false,
    });
    await settle();
    expect(host.spokenInput).toEqual([]);
    await vi.advanceTimersByTimeAsync(VOICE_SEND_HOLD_MS);

    expect(host.spokenInput).toEqual([{ agentId: VOICE_AGENT_ID, text: "also check the logs" }]);
    expect(host.interruptAgentIfRunning).not.toHaveBeenCalled();

    await voiceSession.cleanup();
  });

  test("voice mode started during a run waits for the run to end before reloading the agent", async () => {
    const { voiceSession, host } = createVoiceSession();
    host.setRunActive(true);

    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
    await settle();
    expect(host.reloads).toEqual([]);
    expect(host.interruptAgentIfRunning).not.toHaveBeenCalled();

    host.setRunActive(false);
    await vi.waitFor(() => expect(host.reloads).toHaveLength(1));
    expect(host.reloads[0]?.systemPrompt).toContain("Paseo voice mode is now on.");

    await voiceSession.cleanup();
  });

  test("a spoken turn before the deferred voice prompt lands is sent without the speak tool", async () => {
    vi.useFakeTimers();
    const { voiceSession, detector, sttSession, host } = createVoiceSession();
    host.setRunActive(true);
    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);

    detector.emit("speech_started");
    await settle();
    detector.emit("speech_stopped");
    await settle();
    sttSession.emitCommitted({ segmentId: "segment-1", previousSegmentId: null });
    sttSession.emitTranscript({
      segmentId: "segment-1",
      transcript: "keep going",
      isFinal: true,
      avgLogprob: -0.1,
      isLowConfidence: false,
    });
    await settle();
    await vi.advanceTimersByTimeAsync(VOICE_SEND_HOLD_MS);
    expect(host.speakToolReady).toEqual([false]);

    host.setRunActive(false);
    await vi.waitFor(() => expect(host.reloads).toHaveLength(1));
    await voiceSession.cleanup();
  });

  test("turning voice mode off during a run neither interrupts it nor reloads before it ends", async () => {
    const { voiceSession, host } = createVoiceSession();
    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
    expect(host.reloads).toHaveLength(1);
    host.setRunActive(true);

    await voiceSession.handleSetVoiceMode(false);
    expect(host.reloads).toHaveLength(1);
    expect(host.interruptAgentIfRunning).not.toHaveBeenCalled();

    host.setRunActive(false);
    await vi.waitFor(() => expect(host.reloads).toHaveLength(2));
    expect(host.reloads[1]?.systemPrompt).toContain("Paseo voice mode is now off.");
  });

  test("the agent's next spoken reply still plays after speech that produced no transcript", async () => {
    const tts: TextToSpeechProvider = {
      async synthesizeSpeech() {
        return { stream: Readable.from([Buffer.from("audio")]), format: "pcm;rate=24000" };
      },
    };
    const { voiceSession, detector, sttSession, host, speak } = createVoiceSession(tts);
    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
    detector.emit("speech_started");
    await settle();
    detector.emit("speech_stopped");
    await settle();
    sttSession.emitCommitted({ segmentId: "segment-1", previousSegmentId: null });
    sttSession.emitTranscript({
      segmentId: "segment-1",
      transcript: "background noise",
      isFinal: true,
      avgLogprob: -2.5,
      isLowConfidence: true,
    });
    await settle();

    const playback = speak({ text: "Still working on it." });
    try {
      await waitForAudioOutput(host);
    } finally {
      await voiceSession.cleanup();
      await playback.catch(() => {});
    }
  });

  test("session abort stops later audio even when the speak tool supplies its own signal", async () => {
    const tts: TextToSpeechProvider = {
      async synthesizeSpeech() {
        return { stream: Readable.from([Buffer.from("audio")]), format: "pcm;rate=24000" };
      },
    };
    const { voiceSession, host, speak } = createVoiceSession(tts);
    const external = new AbortController();
    let abortRequested = false;
    const emit = host.emit;
    function acknowledgeLaterAudio(message: SessionOutboundMessage) {
      emit(message);
      if (message.type === "audio_output" && abortRequested)
        voiceSession.handleAudioPlayed(message.payload.id);
    }
    host.emit = acknowledgeLaterAudio;
    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
    const playback = speak({
      text: "First sentence. Second sentence. Third sentence.",
      signal: external.signal,
    });
    try {
      await waitForAudioOutput(host);
      abortRequested = true;
      await voiceSession.handleAbort();
      await playback;
      expect(host.emitted.filter(isAudioOutput)).toHaveLength(1);
      expect(external.signal.aborted).toBe(false);
    } finally {
      external.abort();
      await voiceSession.cleanup();
      await playback.catch(() => {});
    }
  });

  test("surfaces a refused voice-mode agent interruption", async () => {
    const { voiceSession, host } = createVoiceSession();
    host.interruptAgentIfRunning = vi.fn(async () => {
      throw new Error("active run cancellation was not acknowledged");
    });

    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);

    await expect(voiceSession.handleAbort()).rejects.toThrow(
      "active run cancellation was not acknowledged",
    );
    expect(host.interruptAgentIfRunning).toHaveBeenCalledWith(VOICE_AGENT_ID);
    expect(host.emitted).toContainEqual(
      expect.objectContaining({
        type: "activity_log",
        payload: expect.objectContaining({
          type: "error",
          content: "Voice interruption failed: active run cancellation was not acknowledged",
          metadata: { voiceAbortFailed: true },
        }),
      }),
    );

    await voiceSession.cleanup();
  });

  test("delivers the streaming final transcript to the agent exactly once", async () => {
    vi.useFakeTimers();
    const { voiceSession, detector, sttSession, host } = createVoiceSession();

    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
    detector.emit("speech_started");
    await settle();
    detector.emit("speech_stopped");
    await settle();
    sttSession.emitCommitted({ segmentId: "segment-1", previousSegmentId: null });
    sttSession.emitTranscript({
      segmentId: "segment-1",
      transcript: "ship the streaming final",
      isFinal: true,
      language: "en",
      avgLogprob: -0.1,
      isLowConfidence: false,
    });
    await settle();
    await vi.advanceTimersByTimeAsync(VOICE_SEND_HOLD_MS);

    expect(sttSession.commitCount).toBe(1);
    expect(host.spokenInput).toEqual([
      { agentId: VOICE_AGENT_ID, text: "ship the streaming final" },
    ]);
    expect(host.emitted).toContainEqual(
      expect.objectContaining({
        type: "transcription_result",
        payload: expect.objectContaining({
          text: "ship the streaming final",
          language: "en",
          avgLogprob: -0.1,
        }),
      }),
    );

    await voiceSession.cleanup();
  });

  test("emits an empty transcript on finalization timeout without submitting to the agent", async () => {
    vi.useFakeTimers();
    try {
      const { voiceSession, detector, sttSession, host } = createVoiceSession();

      await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
      detector.emit("speech_started");
      await settle();
      detector.emit("speech_stopped");
      await settle();
      sttSession.emitCommitted({ segmentId: "segment-1", previousSegmentId: null });

      await vi.advanceTimersByTimeAsync(10_000);
      await settle();

      expect(host.spokenInput).toEqual([]);
      expect(host.emitted).toContainEqual(
        expect.objectContaining({
          type: "transcription_result",
          payload: expect.objectContaining({ text: "" }),
        }),
      );

      await voiceSession.cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  test("filters a low-confidence streaming final without submitting to the agent", async () => {
    const { voiceSession, detector, sttSession, host } = createVoiceSession();

    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
    detector.emit("speech_started");
    await settle();
    detector.emit("speech_stopped");
    await settle();
    sttSession.emitCommitted({ segmentId: "segment-1", previousSegmentId: null });
    sttSession.emitTranscript({
      segmentId: "segment-1",
      transcript: "background noise",
      isFinal: true,
      avgLogprob: -2.5,
      isLowConfidence: true,
    });
    await settle();

    expect(host.spokenInput).toEqual([]);
    expect(host.emitted).toContainEqual(
      expect.objectContaining({
        type: "transcription_result",
        payload: expect.objectContaining({
          text: "",
          avgLogprob: -2.5,
          isLowConfidence: true,
        }),
      }),
    );

    await voiceSession.cleanup();
  });
});

describe("VoiceSession start", () => {
  test("refuses voice mode with the reason when the agent would have no speak tool", async () => {
    const { voiceSession, host, speak } = createVoiceSession();
    host.speakUnavailable = "Voice mode needs Paseo tools so the agent can speak.";

    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID, "voice-request-1");

    expect(host.emitted).toContainEqual({
      type: "set_voice_mode_response",
      payload: {
        requestId: "voice-request-1",
        enabled: false,
        agentId: null,
        accepted: false,
        error: "Voice mode needs Paseo tools so the agent can speak.",
      },
    });
    expect(host.reloadedAgentIds).toEqual([]);
    expect(() => speak({ text: "hello" })).toThrow("Voice speak handler not registered");

    await voiceSession.cleanup();
  });
});

describe("VoiceSession send words", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("a sent message beeps first, and 'cancel' in the hold keeps it from the agent", async () => {
    vi.useFakeTimers();
    const setup = createVoiceSession(playedTts);
    acknowledgeAudio(setup);
    const { voiceSession, detector, sttSession, host } = setup;
    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);

    await sayTurn(detector, sttSession, "Delete the staging database.", "segment-1");
    await vi.waitFor(() => expect(host.emitted.filter(isAudioOutput)).toHaveLength(1));
    expect(detector.confirmWindows).toEqual([SHORT_WORD_CONFIRM_MS]);

    await sayTurn(detector, sttSession, "Cancel.", "segment-2");
    await vi.advanceTimersByTimeAsync(VOICE_SEND_HOLD_MS * 2);

    expect(host.spokenInput).toEqual([]);
    await vi.waitFor(() => expect(spokenAnnouncements(host)).toEqual(["Cancelled."]));
    expect(detector.confirmWindows).toEqual([SHORT_WORD_CONFIRM_MS, null]);
    await voiceSession.cleanup();
  });

  test("over mode sends only after the word 'over', without the word", async () => {
    vi.useFakeTimers();
    const { voiceSession, detector, sttSession, host } = createVoiceSession(null, {
      sendMode: () => "over",
    });
    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);

    await sayTurn(detector, sttSession, "Fix the login bug.", "segment-1");
    await sayTurn(detector, sttSession, "Then go over the tests.", "segment-2");
    await vi.advanceTimersByTimeAsync(VOICE_SEND_HOLD_MS * 2);
    expect(host.spokenInput).toEqual([]);
    expect(detector.confirmWindows).toEqual([SHORT_WORD_CONFIRM_MS]);

    await sayTurn(detector, sttSession, "Over.", "segment-3");
    await vi.advanceTimersByTimeAsync(VOICE_SEND_HOLD_MS);
    expect(host.spokenInput).toEqual([
      { agentId: VOICE_AGENT_ID, text: "Fix the login bug. Then go over the tests." },
    ]);
    expect(detector.confirmWindows).toEqual([SHORT_WORD_CONFIRM_MS, null]);
    await voiceSession.cleanup();
  });

  test("turning voice off in the hold still sends the message", async () => {
    vi.useFakeTimers();
    const { voiceSession, detector, sttSession, host } = createVoiceSession();
    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);

    await sayTurn(detector, sttSession, "Run the tests.", "segment-1");
    expect(host.spokenInput).toEqual([]);
    await voiceSession.handleSetVoiceMode(false);
    expect(host.spokenInput).toEqual([{ agentId: VOICE_AGENT_ID, text: "Run the tests." }]);
  });
});

describe("VoiceSession navigation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const SCAN_CHAT_ID = "22222222-2222-4222-8222-222222222222";
  const RELEASE_CHAT_ID = "33333333-3333-4333-8333-333333333333";
  const SYNC_CHAT_ID = "44444444-4444-4444-8444-444444444444";
  const chats: VoiceChatProject[] = [
    {
      projectId: "fitup",
      name: "FitUp",
      chats: [
        { agentId: VOICE_AGENT_ID, workspaceId: "w-fitup", title: "Main chat", lastActiveAt: 2 },
        { agentId: SCAN_CHAT_ID, workspaceId: "w-scan", title: "Food scan", lastActiveAt: 1 },
      ],
    },
    {
      projectId: "paseo",
      name: "Paseo",
      chats: [
        { agentId: RELEASE_CHAT_ID, workspaceId: "w-p1", title: "Release beta", lastActiveAt: 2 },
        { agentId: SYNC_CHAT_ID, workspaceId: "w-p2", title: "Upstream sync", lastActiveAt: 1 },
      ],
    },
  ];

  async function startNavigatingSession(agentId: string, navMemory: VoiceNavMemory) {
    const setup = createVoiceSession(playedTts, { navMemory });
    acknowledgeAudio(setup);
    setup.host.chats = chats;
    await setup.voiceSession.handleSetVoiceMode(true, agentId, undefined, { navigation: true });
    return setup;
  }

  function navigations(host: FakeVoiceHost): string[] {
    return host.emitted.flatMap((message) =>
      message.type === "voice.navigate" ? [message.payload.agentId] : [],
    );
  }

  test("'go to <project> <chat>' moves voice there, says where it is, and 'go back' returns", async () => {
    vi.useFakeTimers();
    const memory = createVoiceNavMemory();
    const first = await startNavigatingSession(VOICE_AGENT_ID, memory);

    await sayTurn(first.detector, first.sttSession, "Go to FitUp, food scan.", "segment-1");
    await vi.advanceTimersByTimeAsync(VOICE_SEND_HOLD_MS * 2);
    expect(navigations(first.host)).toEqual([SCAN_CHAT_ID]);
    expect(first.host.spokenInput).toEqual([]);
    expect(first.host.emitted.filter(isAudioOutput)).toEqual([]);

    // The app opens the chat and turns voice off and on again there: a new voice session.
    await first.voiceSession.handleSetVoiceMode(false);
    await first.voiceSession.cleanup();
    const second = await startNavigatingSession(SCAN_CHAT_ID, memory);
    await vi.waitFor(() => expect(spokenAnnouncements(second.host)).toEqual(["FitUp, Food scan."]));

    await sayTurn(second.detector, second.sttSession, "Go back.", "segment-2");
    expect(navigations(second.host)).toEqual([VOICE_AGENT_ID]);
    await second.voiceSession.cleanup();
  });

  test("a project with several chats reads their names, and the next words pick one", async () => {
    vi.useFakeTimers();
    const { voiceSession, detector, sttSession, host } = await startNavigatingSession(
      VOICE_AGENT_ID,
      createVoiceNavMemory(),
    );

    await sayTurn(detector, sttSession, "Go to Paseo.", "segment-1");
    await vi.waitFor(() =>
      expect(spokenAnnouncements(host)).toEqual([
        "Paseo has 2 chats: Release beta, Upstream sync. Which one?",
      ]),
    );
    expect(navigations(host)).toEqual([]);
    // Short words ("go back", a chat name) are heard while nothing plays; the list kept the long window.
    expect(detector.confirmWindows).toEqual([SHORT_WORD_CONFIRM_MS, null, SHORT_WORD_CONFIRM_MS]);
    await sayTurn(detector, sttSession, "The second one.", "segment-2");
    expect(navigations(host)).toEqual([SYNC_CHAT_ID]);

    await sayTurn(detector, sttSession, "Go to Paseo.", "segment-3");
    // The user answers after hearing the names again.
    await vi.waitFor(() => expect(spokenAnnouncements(host)).toHaveLength(2));
    await sayTurn(detector, sttSession, "Tell me a joke.", "segment-4");
    await vi.advanceTimersByTimeAsync(VOICE_SEND_HOLD_MS * 2);
    await vi.waitFor(() => expect(spokenAnnouncements(host)).toContain("No chat called that."));
    expect(navigations(host)).toEqual([SYNC_CHAT_ID]);
    expect(host.spokenInput).toEqual([]);
    await voiceSession.cleanup();
  });

  test("words that name no chat, and every command on an app that cannot move, go to the agent", async () => {
    vi.useFakeTimers();
    const navigating = await startNavigatingSession(VOICE_AGENT_ID, createVoiceNavMemory());
    await sayTurn(navigating.detector, navigating.sttSession, "Go to the auth module.", "s-1");
    await vi.advanceTimersByTimeAsync(VOICE_SEND_HOLD_MS * 2);
    expect(navigating.host.spokenInput).toEqual([
      { agentId: VOICE_AGENT_ID, text: "Go to the auth module." },
    ]);
    await navigating.voiceSession.cleanup();

    const oldApp = createVoiceSession();
    oldApp.host.chats = chats;
    await oldApp.voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
    await sayTurn(oldApp.detector, oldApp.sttSession, "Go to Paseo.", "s-2");
    await vi.advanceTimersByTimeAsync(VOICE_SEND_HOLD_MS * 2);
    expect(navigations(oldApp.host)).toEqual([]);
    expect(oldApp.host.spokenInput).toEqual([{ agentId: VOICE_AGENT_ID, text: "Go to Paseo." }]);
    await oldApp.voiceSession.cleanup();
  });

  const MAC_FOOD_ID = "55555555-5555-4555-8555-555555555555";
  const MAC_GYM_ID = "66666666-6666-4666-8666-666666666666";
  const MAC_SHOP_ID = "77777777-7777-4777-8777-777777777777";
  const fitupOnMac: VoiceChatProject = {
    projectId: "mac-fitup",
    name: "FitUp",
    chats: [
      {
        agentId: MAC_FOOD_ID,
        workspaceId: "mw-food",
        title: "Food scan redesign 🍎",
        lastActiveAt: 2,
      },
      { agentId: MAC_GYM_ID, workspaceId: "mw-gym", title: "Gym log", lastActiveAt: 1 },
    ],
  };
  const groceriesOnMac: VoiceChatProject = {
    projectId: "mac-groceries",
    name: "Groceries",
    chats: [
      { agentId: MAC_SHOP_ID, workspaceId: "mw-shop", title: "Shopping list", lastActiveAt: 1 },
    ],
  };
  const omenProjects = chats;

  /** The app: Omen and Mac, each answering for the other with the shared matcher. */
  function appHosts(askingHost: "Omen" | "Mac", macOnline = true) {
    const hosts: VoiceHostChats[] = [
      { serverId: "omen", hostName: "Omen", online: true, projects: omenProjects },
      {
        serverId: "mac",
        hostName: "Mac",
        online: macOnline,
        projects: [fitupOnMac, groceriesOnMac],
      },
    ];
    const others = hosts.filter((host) => host.hostName !== askingHost);
    return vi.fn(async (query: VoiceFindChatsQuery): Promise<VoiceFindChatsAnswer> => {
      if (query.kind === "name") {
        return { hostName: askingHost, matches: findHostMatches(query.target, others) };
      }
      for (const host of others) {
        if (host.serverId !== query.serverId) continue;
        for (const project of host.projects) {
          if (!project.chats.some((chat) => chat.agentId === query.agentId)) continue;
          const match = { ...host, project, chatAgentId: query.agentId, score: 1 };
          return { hostName: askingHost, matches: [match] };
        }
      }
      return { hostName: askingHost, matches: [] };
    });
  }

  async function startOnHost(
    hostName: "Omen" | "Mac",
    agentId: string,
    options: { macOnline?: boolean; arrival?: VoiceArrival } = {},
  ) {
    const setup = createVoiceSession(playedTts, { navMemory: createVoiceNavMemory() });
    acknowledgeAudio(setup);
    setup.host.chats = hostName === "Omen" ? omenProjects : [fitupOnMac, groceriesOnMac];
    setup.host.findChatsOnOtherHosts = appHosts(hostName, options.macOnline);
    await setup.voiceSession.handleSetVoiceMode(true, agentId, undefined, {
      navigation: true,
      navigationHosts: true,
      arrival: options.arrival,
    });
    return setup;
  }

  function remoteNavigations(host: FakeVoiceHost) {
    return host.emitted.flatMap((message) =>
      message.type === "voice.navigate" ? [message.payload] : [],
    );
  }

  test("a chat on another host moves voice there, which says where it is, and 'go back' returns", async () => {
    vi.useFakeTimers();
    const omen = await startOnHost("Omen", VOICE_AGENT_ID);
    await sayTurn(omen.detector, omen.sttSession, "Go to groceries, shopping list.", "s-1");
    expect(remoteNavigations(omen.host)).toEqual([
      {
        agentId: MAC_SHOP_ID,
        workspaceId: "mw-shop",
        serverId: "mac",
        speech: "Groceries on Mac, Shopping list.",
      },
    ]);
    expect(omen.host.spokenInput).toEqual([]);
    await omen.voiceSession.cleanup();

    // The app turns voice on in the Mac chat with what to say and where it came from.
    const mac = await startOnHost("Mac", MAC_SHOP_ID, {
      arrival: {
        speech: "Groceries on Mac, Shopping list.",
        previous: { serverId: "omen", agentId: VOICE_AGENT_ID },
      },
    });
    await vi.waitFor(() =>
      expect(spokenAnnouncements(mac.host)).toEqual(["Groceries on Mac, Shopping list."]),
    );
    await sayTurn(mac.detector, mac.sttSession, "Go back.", "s-2");
    await vi.waitFor(() =>
      expect(remoteNavigations(mac.host)).toEqual([
        {
          agentId: VOICE_AGENT_ID,
          workspaceId: "w-fitup",
          serverId: "omen",
          speech: "FitUp on Omen, Main chat.",
        },
      ]),
    );
    await mac.voiceSession.cleanup();
  });

  test("the same project on two hosts asks which machine, then which chat", async () => {
    vi.useFakeTimers();
    const omen = await startOnHost("Omen", RELEASE_CHAT_ID);
    await sayTurn(omen.detector, omen.sttSession, "Go to FitUp.", "s-1");
    await vi.waitFor(() =>
      expect(spokenAnnouncements(omen.host)).toEqual(["FitUp on Omen or on Mac?"]),
    );
    await sayTurn(omen.detector, omen.sttSession, "On the Mac.", "s-2");
    await vi.waitFor(() =>
      expect(spokenAnnouncements(omen.host)).toContain(
        "FitUp on Mac has 2 chats: Food scan redesign, Gym log. Which one?",
      ),
    );
    await sayTurn(omen.detector, omen.sttSession, "Gym log.", "s-3");
    expect(remoteNavigations(omen.host)).toEqual([
      expect.objectContaining({ agentId: MAC_GYM_ID, serverId: "mac" }),
    ]);
    expect(omen.host.spokenInput).toEqual([]);
    await omen.voiceSession.cleanup();
  });

  test("a name only an offline host has says so, and voice stays", async () => {
    vi.useFakeTimers();
    const omen = await startOnHost("Omen", VOICE_AGENT_ID, { macOnline: false });
    await sayTurn(omen.detector, omen.sttSession, "Go to groceries.", "s-1");
    await vi.waitFor(() =>
      expect(spokenAnnouncements(omen.host)).toEqual(["Groceries is on Mac, which is offline."]),
    );
    // FitUp is on both: the online Omen copy wins without a question.
    await sayTurn(omen.detector, omen.sttSession, "Go to FitUp, food scan.", "s-2");
    expect(remoteNavigations(omen.host)).toEqual([
      { agentId: SCAN_CHAT_ID, workspaceId: "w-scan" },
    ]);
    expect(omen.host.spokenInput).toEqual([]);
    await omen.voiceSession.cleanup();
  });

  test("an app without host lookup is never asked", async () => {
    vi.useFakeTimers();
    const setup = await startNavigatingSession(VOICE_AGENT_ID, createVoiceNavMemory());
    const ask = appHosts("Omen");
    setup.host.findChatsOnOtherHosts = ask;
    await sayTurn(setup.detector, setup.sttSession, "Go to groceries.", "s-1");
    await vi.advanceTimersByTimeAsync(VOICE_SEND_HOLD_MS * 2);
    expect(ask).not.toHaveBeenCalled();
    expect(setup.host.spokenInput).toEqual([{ agentId: VOICE_AGENT_ID, text: "Go to groceries." }]);
    await setup.voiceSession.cleanup();
  });
});

describe("VoiceSession side helper", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const SCAN_CHAT_ID = "22222222-2222-4222-8222-222222222222";
  const chats: VoiceChatProject[] = [
    {
      projectId: "fitup",
      name: "FitUp",
      chats: [
        { agentId: VOICE_AGENT_ID, workspaceId: "w-fitup", title: "Main chat", lastActiveAt: 2 },
        { agentId: SCAN_CHAT_ID, workspaceId: "w-scan", title: "Food scan", lastActiveAt: 1 },
      ],
    },
  ];

  type Ask = NonNullable<VoiceSessionHost["askSideHelper"]>;

  async function startHelperSession(ask: Ask, options: { navigation?: boolean } = {}) {
    const setup = createVoiceSession(playedTts, { navMemory: createVoiceNavMemory() });
    acknowledgeAudio(setup);
    setup.host.chats = chats;
    const askSideHelper = vi.fn(ask);
    setup.host.askSideHelper = askSideHelper;
    await setup.voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID, undefined, {
      navigation: options.navigation ?? false,
    });
    return { ...setup, askSideHelper };
  }

  test("'Paseo, ...' is answered out loud and never reaches the chat; plain words still do", async () => {
    vi.useFakeTimers();
    const { voiceSession, detector, sttSession, host, askSideHelper } = await startHelperSession(
      async () => "Food scan waits on you for an approval.",
    );

    await sayTurn(detector, sttSession, "Paceo, which chats are waiting on me?", "segment-1");
    await vi.waitFor(() =>
      expect(spokenAnnouncements(host)).toEqual(["Food scan waits on you for an approval."]),
    );
    expect(askSideHelper).toHaveBeenCalledWith(
      expect.objectContaining({
        question: "which chats are waiting on me?",
        currentAgentId: VOICE_AGENT_ID,
      }),
    );
    await vi.advanceTimersByTimeAsync(VOICE_SEND_HOLD_MS * 2);
    expect(host.spokenInput).toEqual([]);

    await sayTurn(detector, sttSession, "Paceo app crashes when I open settings.", "segment-2");
    await vi.advanceTimersByTimeAsync(VOICE_SEND_HOLD_MS * 2);
    expect(host.spokenInput).toEqual([
      { agentId: VOICE_AGENT_ID, text: "Paceo app crashes when I open settings." },
    ]);
    expect(askSideHelper).toHaveBeenCalledTimes(1);
    await voiceSession.cleanup();
  });

  test("a slow answer says 'One sec.', and one past the time box says 'Sorry, no answer.'", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const { voiceSession, detector, sttSession, host } = await startHelperSession(
      (input) =>
        new Promise<string>(() => {
          signal = input.signal;
        }),
    );

    await sayTurn(detector, sttSession, "Paseo, what did the agent just say?", "segment-1");
    await vi.advanceTimersByTimeAsync(SIDE_HELPER_WAIT_MS);
    await vi.waitFor(() => expect(spokenAnnouncements(host)).toEqual(["One sec."]));
    await vi.advanceTimersByTimeAsync(SIDE_HELPER_TIMEOUT_MS);
    await vi.waitFor(() =>
      expect(spokenAnnouncements(host)).toEqual(["One sec.", "Sorry, no answer."]),
    );
    expect(signal?.aborted).toBe(true);
    expect(host.spokenInput).toEqual([]);
    await voiceSession.cleanup();
  });

  test("a failed answer says 'Sorry, no answer.', and voice off mid-question stays silent", async () => {
    vi.useFakeTimers();
    const failing = await startHelperSession(async () => {
      throw new Error("model unavailable");
    });
    await sayTurn(failing.detector, failing.sttSession, "Paseo, what's new?", "segment-1");
    await vi.waitFor(() =>
      expect(spokenAnnouncements(failing.host)).toEqual(["Sorry, no answer."]),
    );
    await failing.voiceSession.cleanup();

    let signal: AbortSignal | undefined;
    const slow = await startHelperSession(
      (input) =>
        new Promise<string>(() => {
          signal = input.signal;
        }),
    );
    await sayTurn(slow.detector, slow.sttSession, "Paseo, what's new?", "segment-2");
    await slow.voiceSession.handleSetVoiceMode(false);
    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(SIDE_HELPER_TIMEOUT_MS * 2);
    expect(spokenAnnouncements(slow.host)).toEqual([]);
    await slow.voiceSession.cleanup();
  });

  test("'Paseo.' alone says 'Yes?' and the next words are the question", async () => {
    vi.useFakeTimers();
    const { voiceSession, detector, sttSession, host, askSideHelper } = await startHelperSession(
      async () => "Nothing waits on you.",
    );
    await sayTurn(detector, sttSession, "Paseo.", "segment-1");
    await vi.waitFor(() => expect(spokenAnnouncements(host)).toEqual(["Yes?"]));
    await sayTurn(detector, sttSession, "Anything waiting on me?", "segment-2");
    await vi.waitFor(() =>
      expect(spokenAnnouncements(host)).toEqual(["Yes?", "Nothing waits on you."]),
    );
    expect(askSideHelper).toHaveBeenCalledWith(
      expect.objectContaining({ question: "Anything waiting on me?" }),
    );
    expect(host.spokenInput).toEqual([]);
    await voiceSession.cleanup();
  });

  test("'Paseo, go to <chat>' still moves voice when navigation is on", async () => {
    vi.useFakeTimers();
    const { voiceSession, detector, sttSession, host, askSideHelper } = await startHelperSession(
      async () => "unused",
      { navigation: true },
    );
    await sayTurn(detector, sttSession, "Paseo, go to food scan.", "segment-1");
    expect(
      host.emitted.flatMap((message) =>
        message.type === "voice.navigate" ? [message.payload.agentId] : [],
      ),
    ).toEqual([SCAN_CHAT_ID]);
    expect(askSideHelper).not.toHaveBeenCalled();
    expect(host.spokenInput).toEqual([]);
    await voiceSession.cleanup();
  });
});
