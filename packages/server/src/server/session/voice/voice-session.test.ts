import { Readable } from "node:stream";
import type { VoiceSpeakHandler } from "../../voice-types.js";
import { EventEmitter } from "node:events";
import pino from "pino";
import { describe, expect, test, vi } from "vitest";

import { VoiceSession, type VoiceSessionHost } from "./voice-session.js";
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
  };
  return host;
}

function createVoiceSession(tts: TextToSpeechProvider | null = null) {
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
    voice: { turnDetection },
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

async function waitForAudioOutput(host: FakeVoiceHost): Promise<void> {
  await vi.waitFor(() => expect(host.emitted.filter(isAudioOutput)).toHaveLength(1));
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("VoiceSession streaming transcription", () => {
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
