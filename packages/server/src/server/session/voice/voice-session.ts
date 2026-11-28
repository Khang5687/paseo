import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import type pino from "pino";
import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import { TTSManager } from "../../agent/tts-manager.js";
import { STTManager } from "../../agent/stt-manager.js";
import type { SpeechToTextProvider, TextToSpeechProvider } from "../../speech/speech-provider.js";
import type { TurnDetectionProvider } from "../../speech/turn-detection-provider.js";
import { maybePersistTtsDebugAudio } from "../../agent/tts-debug.js";
import { isPaseoDictationDebugEnabled } from "../../agent/recordings-debug.js";
import {
  DictationStreamManager,
  type DictationStreamOutboundMessage,
} from "../../dictation/dictation-stream-manager.js";
import { createVoiceTurnController, type VoiceTurnController } from "./voice-turn-controller.js";
import { buildVoiceModeSystemPrompt, stripVoiceModeSystemPrompt } from "../../voice-config.js";
import { VOICE_ACTIVE_ELSEWHERE_REASON_CODE } from "@getpaseo/protocol/voice";
import { VoiceModeAlreadyActiveError } from "../../voice-types.js";
import type { VoiceCallerContext, VoiceSpeakHandler } from "../../voice-types.js";
import type { ManagedAgent } from "../../agent/agent-manager.js";
import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentProvider,
  AgentSessionConfig,
} from "../../agent/agent-sdk-types.js";
import { prepareTextForSpeech } from "./speech-text.js";
import {
  buildPermissionReminderSpeech,
  buildPermissionSpeech,
  buildQuestionSpeech,
  buildUnclearAnswerSpeech,
  interpretSpokenAnswer,
  parseSpokenQuestions,
  type SpokenQuestion,
} from "./spoken-question.js";
import { CANCELLED_SPEECH, SHORT_WORD_CONFIRM_MS, VoiceSendGate } from "./send-gate.js";
import { SEND_CUE_FORMAT, sendCuePcm } from "./send-cue.js";
import { isCancelCommand, type VoiceSendMode } from "./send-words.js";
import type { VoiceChatProject } from "./voice-chat-directory.js";
import {
  NO_CHAT_SPEECH,
  NO_PREVIOUS_CHAT_SPEECH,
  buildAlreadyHereSpeech,
  buildArrivedSpeech,
  buildChatListSpeech,
  buildNoChatsSpeech,
  buildOnlyChatSpeech,
  createVoiceNavMemory,
  findVoiceChat,
  parseVoiceNavCommand,
  resolveChatPick,
  resolveGoToTarget,
  type VoiceNavMemory,
  type VoiceChatTarget,
} from "./voice-navigate.js";
import {
  SIDE_HELPER_FAILED_SPEECH,
  SIDE_HELPER_TIMEOUT_MS,
  SIDE_HELPER_WAIT_MS,
  SIDE_HELPER_WAIT_SPEECH,
  SIDE_HELPER_WAKE_SPEECH,
  parseSideHelperCall,
  type SideHelperCall,
} from "./voice-side-helper.js";
import type { LocalSpeechModelId } from "../../speech/providers/local/models.js";
import { toResolver, type Resolvable } from "../../speech/provider-resolver.js";
import type { SpeechReadinessSnapshot, SpeechReadinessState } from "../../speech/speech-runtime.js";

const PCM_SAMPLE_RATE = 16000;
const PCM_CHANNELS = 1;
const PCM_BITS_PER_SAMPLE = 16;
const PCM_BYTES_PER_MS = (PCM_SAMPLE_RATE * PCM_CHANNELS * (PCM_BITS_PER_SAMPLE / 8)) / 1000;
const MIN_STREAMING_SEGMENT_DURATION_MS = 1000;
const MIN_STREAMING_SEGMENT_BYTES = Math.round(
  PCM_BYTES_PER_MS * MIN_STREAMING_SEGMENT_DURATION_MS,
);
const AgentIdSchema = z.guid();

type ProcessingPhase = "idle" | "transcribing";

interface VoiceModeBaseConfig {
  systemPrompt?: string;
}

interface PendingSpokenQuestion {
  agentId: string;
  request: AgentPermissionRequest;
  questions: SpokenQuestion[];
  /** The question being asked now; a card with several questions is read one at a time. */
  index: number;
  answers: Record<string, string>;
}

interface AudioBufferState {
  chunks: Buffer[];
  format: string;
  isPCM: boolean;
  totalPCMBytes: number;
}

interface VoiceTranscriptionResultPayload {
  text: string;
  requestId: string;
  language?: string;
  duration?: number;
  avgLogprob?: number;
  isLowConfidence?: boolean;
  byteLength?: number;
  format?: string;
  debugRecordingPath?: string;
}

interface VoiceFeatureUnavailableContext {
  reasonCode: SpeechReadinessSnapshot["voiceFeature"]["reasonCode"];
  message: string;
  retryable: boolean;
  missingModelIds: LocalSpeechModelId[];
}

interface VoiceFeatureUnavailableResponseMetadata {
  reasonCode?: SpeechReadinessSnapshot["voiceFeature"]["reasonCode"];
  retryable?: boolean;
  missingModelIds?: LocalSpeechModelId[];
}

class VoiceFeatureUnavailableError extends Error {
  readonly reasonCode: SpeechReadinessSnapshot["voiceFeature"]["reasonCode"];
  readonly retryable: boolean;
  readonly missingModelIds: LocalSpeechModelId[];

  constructor(context: VoiceFeatureUnavailableContext) {
    super(context.message);
    this.name = "VoiceFeatureUnavailableError";
    this.reasonCode = context.reasonCode;
    this.retryable = context.retryable;
    this.missingModelIds = [...context.missingModelIds];
  }
}

function convertPCMToWavBuffer(
  pcmBuffer: Buffer,
  sampleRate: number,
  channels: number,
  bitsPerSample: number,
): Buffer {
  const headerSize = 44;
  const wavBuffer = Buffer.alloc(headerSize + pcmBuffer.length);
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;

  wavBuffer.write("RIFF", 0);
  wavBuffer.writeUInt32LE(36 + pcmBuffer.length, 4);
  wavBuffer.write("WAVE", 8);
  wavBuffer.write("fmt ", 12);
  wavBuffer.writeUInt32LE(16, 16);
  wavBuffer.writeUInt16LE(1, 20);
  wavBuffer.writeUInt16LE(channels, 22);
  wavBuffer.writeUInt32LE(sampleRate, 24);
  wavBuffer.writeUInt32LE(byteRate, 28);
  wavBuffer.writeUInt16LE(blockAlign, 32);
  wavBuffer.writeUInt16LE(bitsPerSample, 34);
  wavBuffer.write("data", 36);
  wavBuffer.writeUInt32LE(pcmBuffer.length, 40);
  pcmBuffer.copy(wavBuffer, 44);

  return wavBuffer;
}

/**
 * The agent-facing operations VoiceSession needs from the session that owns it.
 * VoiceSession owns all voice/audio state; it reaches back through this narrow
 * seam only to deliver transcripts to the agent, drive TTS playback, and
 * abort/inspect the active agent run.
 */
export interface VoiceSessionHost {
  emit(msg: SessionOutboundMessage): void;
  loadAgent(agentId: string): Promise<ManagedAgent>;
  /** Why an agent of this provider would have no `speak` tool, or null when it has one. */
  speakToolUnavailableReason(provider: AgentProvider): string | null;
  reloadAgentSession(
    agentId: string,
    overrides: Partial<AgentSessionConfig>,
  ): Promise<ManagedAgent>;
  respondToPermission(
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<void>;
  sendSpokenInput(
    agentId: string,
    text: string,
    options: { speakToolReady: boolean },
  ): Promise<void>;
  interruptAgentIfRunning(agentId: string): Promise<void>;
  hasActiveAgentRun(agentId: string | null): boolean;
  /** Resolves once the agent has no run in flight, or the signal aborts. */
  waitForAgentIdle(agentId: string, signal?: AbortSignal): Promise<void>;
  /**
   * Projects and chats a spoken "go to" can name. The one place names come from: an app-side
   * lookup across hosts could replace it without touching the command parser.
   */
  listVoiceChats(): Promise<VoiceChatProject[]>;
  /**
   * Answers a "Paseo, ..." question from this daemon's chat data, read-only. Absent: the words
   * go to the chat like any other. Aborting `signal` cancels the model call.
   */
  askSideHelper?(input: {
    question: string;
    currentAgentId: string | null;
    signal: AbortSignal;
  }): Promise<string>;
}

export interface VoiceSessionOptions {
  host: VoiceSessionHost;
  logger: pino.Logger;
  sessionId: string;
  onIdle?: () => void;
  sttLanguage?: string;
  tts: Resolvable<TextToSpeechProvider | null>;
  stt: Resolvable<SpeechToTextProvider | null>;
  voice?: {
    turnDetection?: Resolvable<TurnDetectionProvider | null>;
    /** The host's send mode, read at every utterance so a settings change applies at once. */
    sendMode?: () => VoiceSendMode;
  };
  voiceBridge?: {
    registerVoiceSpeakHandler?: (agentId: string, handler: VoiceSpeakHandler) => void;
    unregisterVoiceSpeakHandler?: (agentId: string) => void;
    registerVoiceCallerContext?: (agentId: string, context: VoiceCallerContext) => void;
    unregisterVoiceCallerContext?: (agentId: string) => void;
  };
  dictation?: {
    finalTimeoutMs?: number;
    stt?: Resolvable<SpeechToTextProvider | null>;
    sttLanguage?: string;
    getSpeechReadiness?: () => SpeechReadinessSnapshot;
  };
  /** Kept by the caller per socket, so "go back" and the arrival speech survive a move. */
  navMemory?: VoiceNavMemory;
}

/**
 * Owns the voice half of a client session: speech-to-text/text-to-speech
 * managers, dictation streaming, the barge-in audio-buffering state machine,
 * voice-turn detection, and the MCP voice bridge. The session delegates the
 * voice/dictation/abort message types here and otherwise knows nothing about
 * audio buffering or processing phases.
 */
export class VoiceSession {
  private readonly host: VoiceSessionHost;
  private readonly sessionLogger: pino.Logger;
  private readonly sessionId: string;
  private readonly sttLanguage: string;

  private abortController: AbortController;
  private closed = false;
  private readonly onIdle: (() => void) | undefined;
  private processingPhase: ProcessingPhase = "idle";

  private isVoiceMode = false;
  private speechInProgress = false;

  private readonly dictationStreamManager: DictationStreamManager;
  private readonly resolveVoiceTurnDetection: () => TurnDetectionProvider | null;
  private voiceTurnController: VoiceTurnController | null = null;
  private voiceInputChunkCount = 0;
  private voiceInputBytes = 0;
  private voiceInputWindowStartedAt = Date.now();

  // Audio buffering for interruption handling
  private pendingAudioSegments: Array<{ audio: Buffer; format: string }> = [];
  private bufferTimeout: ReturnType<typeof setTimeout> | null = null;
  private audioBuffer: AudioBufferState | null = null;

  // Optional TTS debug capture (persisted per utterance)
  private readonly ttsDebugStreams = new Map<string, { format: string; chunks: Buffer[] }>();

  private readonly ttsManager: TTSManager;
  private readonly sttManager: STTManager;

  private readonly registerVoiceSpeakHandler?: (
    agentId: string,
    handler: VoiceSpeakHandler,
  ) => void;
  private readonly unregisterVoiceSpeakHandler?: (agentId: string) => void;
  private readonly registerVoiceCallerContext?: (
    agentId: string,
    context: VoiceCallerContext,
  ) => void;
  private readonly unregisterVoiceCallerContext?: (agentId: string) => void;
  private readonly getSpeechReadiness?: () => SpeechReadinessSnapshot;

  private voiceModeAgentId: string | null = null;
  private voiceModeBaseConfig: VoiceModeBaseConfig | null = null;
  /** Set while voice mode started during a run and the voice prompt waits for the run to end. */
  private deferredVoicePrompt: AbortController | null = null;

  private pendingQuestion: PendingSpokenQuestion | null = null;
  private readonly announcedRequestIds = new Set<string>();
  /** Permission prompts read aloud and still waiting for an on-screen answer. */
  private readonly pendingPermissionIds = new Set<string>();
  private announcementChain: Promise<void> = Promise.resolve();
  /** When a spoken utterance becomes a message: send mode, beep, hold and "cancel". */
  private readonly sendGate: VoiceSendGate;
  private readonly navMemory: VoiceNavMemory;
  /** The app moves voice on `voice.navigate`; only then is speech read as a navigation command. */
  private navigationEnabled = false;
  /** Chat names were read out; the next utterance picks one. */
  private pendingChatPick: VoiceChatProject | null = null;
  /** Send gate state: a held message, or over-mode text waiting for its "over". */
  private expectingShortWord = false;
  /** Speech clips being played now; the VAD keeps its long window while any plays. */
  private activePlaybacks = 0;
  private appliedSpeechConfirmMs: number | null = null;
  /** "Paseo." was said alone; the next utterance is the side question. */
  private sideHelperWoken = false;
  /** The side question being answered; a newer one or voice off cancels it. */
  private sideHelperRun: AbortController | null = null;

  constructor(options: VoiceSessionOptions) {
    const { host, logger, sessionId, sttLanguage, tts, stt, voice, voiceBridge, dictation } =
      options;
    this.host = host;
    this.onIdle = options.onIdle;
    this.sessionLogger = logger;
    this.sessionId = sessionId;
    this.sttLanguage = sttLanguage ?? "en";
    this.abortController = new AbortController();

    this.resolveVoiceTurnDetection = toResolver(voice?.turnDetection ?? null);
    this.registerVoiceSpeakHandler = voiceBridge?.registerVoiceSpeakHandler;
    this.unregisterVoiceSpeakHandler = voiceBridge?.unregisterVoiceSpeakHandler;
    this.registerVoiceCallerContext = voiceBridge?.registerVoiceCallerContext;
    this.unregisterVoiceCallerContext = voiceBridge?.unregisterVoiceCallerContext;
    this.getSpeechReadiness = dictation?.getSpeechReadiness;

    this.ttsManager = new TTSManager(this.sessionId, this.sessionLogger, tts);
    this.sttManager = new STTManager(this.sessionId, this.sessionLogger, stt, {
      language: sttLanguage,
    });
    this.dictationStreamManager = new DictationStreamManager({
      logger: this.sessionLogger,
      sessionId: this.sessionId,
      emit: (msg) => this.handleDictationManagerMessage(msg),
      stt: dictation?.stt ?? null,
      language: dictation?.sttLanguage,
      finalTimeoutMs: dictation?.finalTimeoutMs,
      onIdle: this.onIdle,
    });
    const resolveSendMode = voice?.sendMode ?? (() => "auto" as const);
    this.sendGate = new VoiceSendGate({
      getMode: resolveSendMode,
      send: (text) => this.deliverSpokenMessage(text),
      playSendCue: () => this.playSendCue(),
      speak: (text) => this.queueAnnouncement(text),
      setExpectingShortWord: (expecting) => {
        this.expectingShortWord = expecting;
        this.refreshSpeechConfirm();
      },
      onSendError: (error) => this.reportSendError(error),
    });
    this.navMemory = options.navMemory ?? createVoiceNavMemory();
  }

  get hasDemand(): boolean {
    return (
      this.isVoiceMode ||
      this.dictationStreamManager.hasDemand ||
      this.processingPhase !== "idle" ||
      this.audioBuffer !== null ||
      this.pendingAudioSegments.length > 0
    );
  }

  isActiveForAgent(agentId: string): boolean {
    return this.isVoiceMode && this.voiceModeAgentId === agentId;
  }

  handleDictationChunk(params: {
    dictationId: string;
    seq: number;
    audioBase64: string;
    format: string;
  }): Promise<void> {
    return this.dictationStreamManager.handleChunk(params);
  }

  handleDictationFinish(dictationId: string, finalSeq: number): Promise<void> {
    return this.dictationStreamManager.handleFinish(dictationId, finalSeq);
  }

  handleDictationCancel(dictationId: string): void {
    this.dictationStreamManager.handleCancel(dictationId);
  }

  async handleDictationStreamStart(
    msg: Extract<SessionInboundMessage, { type: "dictation_stream_start" }>,
  ): Promise<void> {
    const unavailable = this.resolveVoiceFeatureUnavailableContext("dictation");
    if (unavailable) {
      this.emit({
        type: "dictation_stream_error",
        payload: {
          dictationId: msg.dictationId,
          error: unavailable.message,
          retryable: unavailable.retryable,
          reasonCode: unavailable.reasonCode,
          missingModelIds: unavailable.missingModelIds,
        },
      });
      return;
    }
    await this.dictationStreamManager.handleStart(msg.dictationId, msg.format);
  }

  private toVoiceFeatureUnavailableContext(
    state: SpeechReadinessState,
  ): VoiceFeatureUnavailableContext {
    return {
      reasonCode: state.reasonCode,
      message: state.message,
      retryable: state.retryable,
      missingModelIds: [...state.missingModelIds],
    };
  }

  private resolveModeReadinessState(
    readiness: SpeechReadinessSnapshot,
    mode: "voice_mode" | "dictation",
  ): SpeechReadinessState {
    if (mode === "voice_mode") {
      return readiness.realtimeVoice;
    }
    return readiness.dictation;
  }

  private getVoiceFeatureUnavailableResponseMetadata(
    error: unknown,
  ): VoiceFeatureUnavailableResponseMetadata {
    if (!(error instanceof VoiceFeatureUnavailableError)) {
      return {};
    }
    return {
      reasonCode: error.reasonCode,
      retryable: error.retryable,
      missingModelIds: error.missingModelIds,
    };
  }

  private resolveVoiceFeatureUnavailableContext(
    mode: "voice_mode" | "dictation",
  ): VoiceFeatureUnavailableContext | null {
    const readiness = this.getSpeechReadiness?.();
    if (!readiness) {
      return null;
    }

    const modeReadiness = this.resolveModeReadinessState(readiness, mode);
    if (!modeReadiness.enabled) {
      return this.toVoiceFeatureUnavailableContext(modeReadiness);
    }
    if (!readiness.voiceFeature.available) {
      return this.toVoiceFeatureUnavailableContext(readiness.voiceFeature);
    }
    if (!modeReadiness.available) {
      return this.toVoiceFeatureUnavailableContext(modeReadiness);
    }
    return null;
  }

  /**
   * Handle voice mode toggle. `navigation`: the app moves voice when told to (`voice.navigate`).
   */
  async handleSetVoiceMode(
    enabled: boolean,
    agentId?: string,
    requestId?: string,
    options: { navigation?: boolean } = {},
  ): Promise<void> {
    const startedAt = Date.now();
    try {
      this.sessionLogger.info(
        { enabled, requestedAgentId: agentId ?? null, requestId: requestId ?? null },
        "set_voice_mode started",
      );
      if (enabled) {
        const unavailable = this.resolveVoiceFeatureUnavailableContext("voice_mode");
        if (unavailable) {
          throw new VoiceFeatureUnavailableError(unavailable);
        }

        const normalizedAgentId = this.parseVoiceTargetAgentId(agentId ?? "", "set_voice_mode");

        if (
          this.isVoiceMode &&
          this.voiceModeAgentId &&
          this.voiceModeAgentId !== normalizedAgentId
        ) {
          this.sessionLogger.info(
            {
              previousAgentId: this.voiceModeAgentId,
              nextAgentId: normalizedAgentId,
              elapsedMs: Date.now() - startedAt,
            },
            "set_voice_mode disabling previous active voice agent",
          );
          await this.disableVoiceModeForActiveAgent(true);
        }

        if (!this.isVoiceMode || this.voiceModeAgentId !== normalizedAgentId) {
          this.sessionLogger.info(
            { agentId: normalizedAgentId, elapsedMs: Date.now() - startedAt },
            "set_voice_mode enabling voice for agent",
          );
          const refreshedAgentId = await this.enableVoiceModeForAgent(normalizedAgentId);
          this.voiceModeAgentId = refreshedAgentId;
          if (this.closed) {
            await this.disableVoiceModeForActiveAgent(true);
            return;
          }
          this.sessionLogger.info(
            { agentId: refreshedAgentId, elapsedMs: Date.now() - startedAt },
            "set_voice_mode agent enable complete",
          );
        }

        this.sessionLogger.info(
          { agentId: this.voiceModeAgentId, elapsedMs: Date.now() - startedAt },
          "set_voice_mode starting voice turn controller",
        );
        await this.startVoiceTurnController();
        this.sessionLogger.info(
          { agentId: this.voiceModeAgentId, elapsedMs: Date.now() - startedAt },
          "set_voice_mode voice turn controller started",
        );
        this.isVoiceMode = !this.closed;
        this.navigationEnabled = options.navigation === true;
        this.refreshSpeechConfirm();
        this.recordVoiceArrival(normalizedAgentId);
        this.sessionLogger.info(
          {
            agentId: this.voiceModeAgentId,
            elapsedMs: Date.now() - startedAt,
          },
          "Voice mode enabled for existing agent",
        );
        if (requestId) {
          this.emit({
            type: "set_voice_mode_response",
            payload: {
              requestId,
              enabled: true,
              agentId: this.voiceModeAgentId,
              accepted: true,
              error: null,
            },
          });
        }
        return;
      }

      this.sessionLogger.info(
        { agentId: this.voiceModeAgentId, elapsedMs: Date.now() - startedAt },
        "set_voice_mode disabling active voice mode",
      );
      await this.disableVoiceModeForActiveAgent(true);
      this.isVoiceMode = false;
      this.navigationEnabled = false;
      this.refreshSpeechConfirm();
      this.pendingChatPick = null;
      this.cancelSideHelper();
      this.sessionLogger.info({ elapsedMs: Date.now() - startedAt }, "Voice mode disabled");
      if (requestId) {
        this.emit({
          type: "set_voice_mode_response",
          payload: {
            requestId,
            enabled: false,
            agentId: null,
            accepted: true,
            error: null,
          },
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Failed to set voice mode";
      const unavailable = this.getVoiceFeatureUnavailableResponseMetadata(error);
      this.sessionLogger.error(
        {
          err: error,
          enabled,
          requestedAgentId: agentId ?? null,
          elapsedMs: Date.now() - startedAt,
        },
        "set_voice_mode failed",
      );
      if (requestId) {
        this.emit({
          type: "set_voice_mode_response",
          payload: {
            requestId,
            enabled: this.isVoiceMode,
            agentId: this.voiceModeAgentId,
            accepted: false,
            error: errorMessage,
            ...unavailable,
            ...(error instanceof VoiceModeAlreadyActiveError
              ? { reasonCode: VOICE_ACTIVE_ELSEWHERE_REASON_CODE, retryable: false }
              : {}),
          },
        });
        return;
      }
      throw error;
    }
  }

  private parseVoiceTargetAgentId(rawId: string, source: string): string {
    const parsed = AgentIdSchema.safeParse(rawId.trim());
    if (!parsed.success) {
      throw new Error(`${source}: agentId must be a UUID`);
    }
    return parsed.data;
  }

  private async enableVoiceModeForAgent(agentId: string): Promise<string> {
    const startedAt = Date.now();
    this.sessionLogger.info({ agentId }, "enableVoiceModeForAgent.ensureAgentLoaded.start");
    const existing = await this.host.loadAgent(agentId);
    if (this.closed) throw new Error("Voice source is closed");
    this.sessionLogger.info(
      { agentId, elapsedMs: Date.now() - startedAt },
      "enableVoiceModeForAgent.ensureAgentLoaded.done",
    );

    // Voice mode answers only through `speak`; without it the agent would stay silent.
    const speakUnavailable = this.host.speakToolUnavailableReason(existing.provider);
    if (speakUnavailable) throw new Error(speakUnavailable);

    this.registerVoiceBridgeForAgent(agentId);

    const baseConfig: VoiceModeBaseConfig = {
      systemPrompt: stripVoiceModeSystemPrompt(existing.config.systemPrompt),
    };
    this.voiceModeBaseConfig = baseConfig;
    const refreshOverrides: Partial<AgentSessionConfig> = {
      systemPrompt: buildVoiceModeSystemPrompt(baseConfig.systemPrompt, true),
    };

    if (this.host.hasActiveAgentRun(agentId)) {
      // The reload that installs the voice prompt would cancel the run. Voice starts now and
      // the prompt follows once the run ends, so spoken input meanwhile carries no speak tool.
      this.sessionLogger.info({ agentId }, "enableVoiceModeForAgent.reload deferred: run active");
      const deferred = new AbortController();
      this.deferredVoicePrompt = deferred;
      void this.reloadAgentWhenIdle(agentId, refreshOverrides, deferred.signal)
        .then(() => {
          if (this.deferredVoicePrompt === deferred) this.deferredVoicePrompt = null;
          return undefined;
        })
        .catch((error) => {
          this.sessionLogger.warn({ err: error, agentId }, "Deferred voice prompt reload failed");
        });
      return agentId;
    }

    try {
      this.sessionLogger.info(
        { agentId, elapsedMs: Date.now() - startedAt },
        "enableVoiceModeForAgent.reloadAgentSession.start",
      );
      const refreshed = await this.host.reloadAgentSession(agentId, refreshOverrides);
      this.sessionLogger.info(
        { agentId, refreshedAgentId: refreshed.id, elapsedMs: Date.now() - startedAt },
        "enableVoiceModeForAgent.reloadAgentSession.done",
      );
      return refreshed.id;
    } catch (error) {
      this.unregisterVoiceSpeakHandler?.(agentId);
      this.unregisterVoiceCallerContext?.(agentId);
      this.voiceModeBaseConfig = null;
      throw error;
    }
  }

  /** A reload cancels the agent's run in flight, so it waits for the run to end. */
  private async reloadAgentWhenIdle(
    agentId: string,
    overrides: Partial<AgentSessionConfig>,
    signal?: AbortSignal,
  ): Promise<void> {
    while (this.host.hasActiveAgentRun(agentId)) {
      await this.host.waitForAgentIdle(agentId, signal);
      if (signal?.aborted) return;
    }
    this.sessionLogger.info({ agentId }, "Applying deferred voice prompt: run ended");
    await this.host.reloadAgentSession(agentId, overrides);
  }

  private async disableVoiceModeForActiveAgent(restoreAgentConfig: boolean): Promise<void> {
    // A message in its send hold was already confirmed by the beep; it goes before voice ends.
    await this.sendGate.flush().catch((error) => this.reportSendError(error));
    this.pendingQuestion = null;
    this.pendingPermissionIds.clear();
    await this.stopVoiceTurnController();

    const agentId = this.voiceModeAgentId;
    if (!agentId) {
      this.voiceModeBaseConfig = null;
      return;
    }

    this.deferredVoicePrompt?.abort();
    // Restoring the prompt reloads the session, and a reload cancels a run in flight.
    // A prompt that never reached the agent needs no restoring.
    if (restoreAgentConfig && this.voiceModeBaseConfig && !this.deferredVoicePrompt) {
      const baseConfig = this.voiceModeBaseConfig;
      const restoring = this.reloadAgentWhenIdle(agentId, {
        systemPrompt: buildVoiceModeSystemPrompt(baseConfig.systemPrompt, false),
      }).catch((error) => {
        this.sessionLogger.warn(
          { err: error, agentId },
          "Failed to restore agent config while disabling voice mode",
        );
      });
      // Voice mode ends now; the restore may wait for a run to end.
      if (!this.host.hasActiveAgentRun(agentId)) await restoring;
    }
    this.deferredVoicePrompt = null;

    this.unregisterVoiceSpeakHandler?.(agentId);
    this.unregisterVoiceCallerContext?.(agentId);
    this.voiceModeBaseConfig = null;
    this.voiceModeAgentId = null;
  }

  private handleDictationManagerMessage(msg: DictationStreamOutboundMessage): void {
    this.emit(msg as unknown as SessionOutboundMessage);
  }

  private async startVoiceTurnController(): Promise<void> {
    if (this.voiceTurnController) {
      this.sessionLogger.info("startVoiceTurnController skipped: already running");
      return;
    }

    const turnDetection = this.resolveVoiceTurnDetection();
    if (!turnDetection) {
      throw new Error("Voice turn detection is not configured");
    }
    const stt = this.sttManager.getProvider();
    if (!stt) {
      throw new Error("Voice speech-to-text is not configured");
    }

    this.sessionLogger.info(
      { providerId: turnDetection.id },
      "startVoiceTurnController creating controller",
    );

    const controller = createVoiceTurnController({
      logger: this.sessionLogger.child({ component: "voice-turn-controller" }),
      turnDetection,
      stt,
      sttLanguage: this.sttLanguage,
      callbacks: {
        onSpeechStarted: async () => {
          // Voice STT providers return final transcripts only. Use the detector's
          // confirmed speech event so interruption does not wait for transcription.
          this.sessionLogger.debug("Voice VAD speech_started");
          this.emit({
            type: "voice_input_state",
            payload: {
              isSpeaking: true,
            },
          });
          this.sendGate.handleSpeechStarted();
          this.handleVoiceSpeechStart();
        },
        onPartialTranscript: async ({ segmentId, transcript }) => {
          this.sessionLogger.debug(
            { segmentId, transcriptLength: transcript.trim().length },
            "Voice partial transcript",
          );
        },
        onSpeechStopped: async () => {
          this.handleVoiceSpeechStopped();
          this.setPhase("transcribing");
          this.emit({
            type: "activity_log",
            payload: {
              id: uuidv4(),
              timestamp: new Date(),
              type: "system",
              content: "Transcribing audio...",
            },
          });
        },
        onFinalTranscript: async ({
          transcript,
          language,
          durationMs,
          avgLogprob,
          isLowConfidence,
        }) => {
          const requestId = uuidv4();
          const transcriptText = isLowConfidence ? "" : transcript.trim();
          if (isLowConfidence) {
            this.sessionLogger.debug(
              { text: transcript, avgLogprob },
              "Filtered low-confidence transcription (likely non-speech)",
            );
          }
          this.sessionLogger.info(
            {
              requestId,
              isVoiceMode: this.isVoiceMode,
              transcriptLength: transcriptText.length,
              transcript: transcriptText,
            },
            "Transcription result",
          );
          await this.handleTranscriptionResultPayload({
            text: transcriptText,
            requestId,
            ...(language ? { language } : {}),
            duration: durationMs,
            ...(avgLogprob !== undefined ? { avgLogprob } : {}),
            ...(isLowConfidence !== undefined ? { isLowConfidence } : {}),
          });
        },
        onError: (error) => {
          this.sessionLogger.error({ err: error }, "Voice turn controller failed");
        },
      },
    });

    this.sessionLogger.info("startVoiceTurnController connecting controller");
    this.voiceTurnController = controller;
    // A new controller starts on the default window.
    this.appliedSpeechConfirmMs = null;
    await controller.start();
    if (this.closed) await controller.stop();
    this.sessionLogger.info("startVoiceTurnController connected");
  }

  private async stopVoiceTurnController(): Promise<void> {
    if (!this.voiceTurnController) {
      return;
    }

    const controller = this.voiceTurnController;
    this.voiceTurnController = null;
    await controller.stop();
  }

  private handleVoiceSpeechStopped(): void {
    this.sessionLogger.info("voice_input_state emitting isSpeaking=false");
    this.emit({
      type: "voice_input_state",
      payload: {
        isSpeaking: false,
      },
    });
  }

  private async ensureAudioBufferForFormat(
    chunkFormat: string,
    isPCMChunk: boolean,
  ): Promise<AudioBufferState> {
    if (!this.audioBuffer) {
      this.audioBuffer = {
        chunks: [],
        format: chunkFormat,
        isPCM: isPCMChunk,
        totalPCMBytes: 0,
      };
      return this.audioBuffer;
    }
    if (this.audioBuffer.isPCM !== isPCMChunk) {
      this.sessionLogger.debug(
        {
          oldFormat: this.audioBuffer.isPCM ? "pcm" : this.audioBuffer.format,
          newFormat: chunkFormat,
        },
        `Audio format changed mid-stream, flushing current buffer`,
      );
      const finalized = this.finalizeBufferedAudio();
      if (finalized) {
        await this.processCompletedAudio(finalized.audio, finalized.format);
      }
      this.audioBuffer = {
        chunks: [],
        format: chunkFormat,
        isPCM: isPCMChunk,
        totalPCMBytes: 0,
      };
      return this.audioBuffer;
    }
    if (!this.audioBuffer.isPCM) {
      this.audioBuffer.format = chunkFormat;
    }
    return this.audioBuffer;
  }

  private async forwardAudioChunkToVoiceTurn(
    msg: Extract<SessionInboundMessage, { type: "voice_audio_chunk" }>,
    chunkFormat: string,
  ): Promise<void> {
    if (!this.voiceTurnController) {
      throw new Error("Voice mode is enabled but the voice turn controller is not running");
    }
    const chunkBytes = Buffer.byteLength(msg.audio, "base64");
    this.voiceInputChunkCount += 1;
    this.voiceInputBytes += chunkBytes;
    const now = Date.now();
    if (this.voiceInputChunkCount % 50 === 0 || now - this.voiceInputWindowStartedAt >= 1000) {
      this.sessionLogger.info(
        {
          chunkCount: this.voiceInputChunkCount,
          audioBytes: this.voiceInputBytes,
          windowMs: now - this.voiceInputWindowStartedAt,
          format: chunkFormat,
        },
        "Voice input chunk summary",
      );
      this.voiceInputWindowStartedAt = now;
      this.voiceInputChunkCount = 0;
      this.voiceInputBytes = 0;
    }
    await this.voiceTurnController.appendClientChunk({
      audioBase64: msg.audio,
      format: chunkFormat,
    });
  }

  async handleAudioChunk(
    msg: Extract<SessionInboundMessage, { type: "voice_audio_chunk" }>,
  ): Promise<void> {
    if (!this.isVoiceMode) {
      this.sessionLogger.warn(
        "Received voice_audio_chunk while voice mode is disabled; transcript will be emitted but voice assistant turn is skipped",
      );
    }

    const chunkFormat = msg.format || "audio/wav";

    if (this.isVoiceMode) {
      await this.forwardAudioChunkToVoiceTurn(msg, chunkFormat);
      return;
    }

    const chunkBuffer = Buffer.from(msg.audio, "base64");
    const isPCMChunk = chunkFormat.toLowerCase().includes("pcm");

    const buffer = await this.ensureAudioBufferForFormat(chunkFormat, isPCMChunk);

    buffer.chunks.push(chunkBuffer);
    if (buffer.isPCM) {
      buffer.totalPCMBytes += chunkBuffer.length;
    }

    // In non-voice mode, use streaming threshold to process chunks
    const reachedStreamingThreshold =
      !this.isVoiceMode && buffer.isPCM && buffer.totalPCMBytes >= MIN_STREAMING_SEGMENT_BYTES;

    if (!msg.isLast && reachedStreamingThreshold) {
      return;
    }

    const bufferedState = this.audioBuffer;
    const finalized = this.finalizeBufferedAudio();
    if (!finalized) {
      return;
    }

    if (!msg.isLast && reachedStreamingThreshold) {
      this.sessionLogger.debug(
        {
          minDuration: MIN_STREAMING_SEGMENT_DURATION_MS,
          pcmBytes: bufferedState?.totalPCMBytes ?? 0,
        },
        `Minimum chunk duration reached (~${MIN_STREAMING_SEGMENT_DURATION_MS}ms, ${
          bufferedState?.totalPCMBytes ?? 0
        } PCM bytes) – triggering STT`,
      );
    } else {
      this.sessionLogger.debug(
        { audioBytes: finalized.audio.length, chunks: bufferedState?.chunks.length ?? 0 },
        `Complete audio segment (${finalized.audio.length} bytes, ${bufferedState?.chunks.length ?? 0} chunk(s))`,
      );
    }

    await this.processCompletedAudio(finalized.audio, finalized.format);
  }

  private finalizeBufferedAudio(): { audio: Buffer; format: string } | null {
    if (!this.audioBuffer) {
      return null;
    }

    const bufferState = this.audioBuffer;
    this.audioBuffer = null;

    if (bufferState.isPCM) {
      const pcmBuffer = Buffer.concat(bufferState.chunks);
      const wavBuffer = convertPCMToWavBuffer(
        pcmBuffer,
        PCM_SAMPLE_RATE,
        PCM_CHANNELS,
        PCM_BITS_PER_SAMPLE,
      );
      return {
        audio: wavBuffer,
        format: "audio/wav",
      };
    }

    return {
      audio: Buffer.concat(bufferState.chunks),
      format: bufferState.format,
    };
  }

  private async processCompletedAudio(audio: Buffer, format: string): Promise<void> {
    if (this.processingPhase === "transcribing") {
      this.sessionLogger.debug(
        { phase: this.processingPhase, segmentCount: this.pendingAudioSegments.length + 1 },
        `Buffering audio segment (phase: ${this.processingPhase})`,
      );
      this.pendingAudioSegments.push({
        audio,
        format,
      });
      this.setBufferTimeout();
      return;
    }

    if (this.pendingAudioSegments.length > 0) {
      this.pendingAudioSegments.push({
        audio,
        format,
      });
      this.sessionLogger.debug(
        { segmentCount: this.pendingAudioSegments.length },
        `Processing ${this.pendingAudioSegments.length} buffered segments together`,
      );

      const pendingSegments = [...this.pendingAudioSegments];
      this.pendingAudioSegments = [];
      this.clearBufferTimeout();

      const combinedAudio = Buffer.concat(pendingSegments.map((segment) => segment.audio));
      const combinedFormat = pendingSegments[pendingSegments.length - 1].format;

      await this.processAudio(combinedAudio, combinedFormat);
      return;
    }

    await this.processAudio(audio, format);
  }

  private async flushPendingAudioSegments(reason: string): Promise<void> {
    if (this.processingPhase === "transcribing" || this.pendingAudioSegments.length === 0) {
      return;
    }

    const pendingSegments = [...this.pendingAudioSegments];
    this.pendingAudioSegments = [];
    this.clearBufferTimeout();

    this.sessionLogger.debug(
      { reason, segmentCount: pendingSegments.length },
      `Flushing ${pendingSegments.length} buffered audio segment(s)`,
    );

    const combinedAudio = Buffer.concat(pendingSegments.map((segment) => segment.audio));
    const combinedFormat = pendingSegments[pendingSegments.length - 1].format;

    await this.processAudio(combinedAudio, combinedFormat);
  }

  /**
   * Process audio through STT and then LLM
   */
  private async processAudio(audio: Buffer, format: string): Promise<void> {
    this.setPhase("transcribing");

    this.emit({
      type: "activity_log",
      payload: {
        id: uuidv4(),
        timestamp: new Date(),
        type: "system",
        content: "Transcribing audio...",
      },
    });

    try {
      const requestId = uuidv4();
      const result = await this.sttManager.transcribe(audio, format, {
        requestId,
        label: this.isVoiceMode ? "voice" : "buffered",
      });

      const transcriptText = result.text.trim();
      this.sessionLogger.info(
        {
          requestId,
          isVoiceMode: this.isVoiceMode,
          transcriptLength: transcriptText.length,
          transcript: transcriptText,
        },
        "Transcription result",
      );

      await this.handleTranscriptionResultPayload({
        text: result.text,
        language: result.language,
        duration: result.duration,
        requestId,
        avgLogprob: result.avgLogprob,
        isLowConfidence: result.isLowConfidence,
        byteLength: result.byteLength,
        format: result.format,
        debugRecordingPath: result.debugRecordingPath,
      });
    } catch (error) {
      this.setPhase("idle");
      this.clearSpeechInProgress("transcription error");
      this.createAbortController();
      await this.flushPendingAudioSegments("transcription error");
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Transcription error: ${getErrorMessage(error)}`,
        },
      });
      throw error;
    }
  }

  private async handleTranscriptionResultPayload(
    result: VoiceTranscriptionResultPayload,
  ): Promise<void> {
    const transcriptText = result.text.trim();

    this.emit({
      type: "transcription_result",
      payload: {
        text: result.text,
        ...(result.language ? { language: result.language } : {}),
        ...(result.duration !== undefined ? { duration: result.duration } : {}),
        requestId: result.requestId,
        ...(result.avgLogprob !== undefined ? { avgLogprob: result.avgLogprob } : {}),
        ...(result.isLowConfidence !== undefined
          ? { isLowConfidence: result.isLowConfidence }
          : {}),
        ...(result.byteLength !== undefined ? { byteLength: result.byteLength } : {}),
        ...(result.format ? { format: result.format } : {}),
        ...(result.debugRecordingPath ? { debugRecordingPath: result.debugRecordingPath } : {}),
      },
    });

    if (!transcriptText) {
      this.sessionLogger.debug("Empty transcription (false positive), not aborting");
      this.setPhase("idle");
      this.clearSpeechInProgress("empty transcription");
      // Detected speech stopped playback. The agent's run goes on, so its next spoken
      // reply must not start on the aborted signal.
      this.createAbortController();
      // Noise during a send hold: the held message goes once its window is over.
      if (this.isVoiceMode) await this.sendGate.settleHeldMessage("");
      await this.flushPendingAudioSegments("empty transcription");
      return;
    }

    // Has content - abort any in-progress stream now
    this.createAbortController();

    if (result.debugRecordingPath) {
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "system",
          content: `Saved input audio: ${result.debugRecordingPath}`,
          metadata: {
            recordingPath: result.debugRecordingPath,
            ...(result.format ? { format: result.format } : {}),
            requestId: result.requestId,
          },
        },
      });
    }

    this.emit({
      type: "activity_log",
      payload: {
        id: uuidv4(),
        timestamp: new Date(),
        type: "transcript",
        content: result.text,
        metadata: {
          ...(result.language ? { language: result.language } : {}),
          ...(result.duration !== undefined ? { duration: result.duration } : {}),
        },
      },
    });

    this.clearSpeechInProgress("transcription complete");
    this.setPhase("idle");
    if (!this.isVoiceMode) {
      this.sessionLogger.debug(
        { requestId: result.requestId },
        "Skipping voice agent processing because voice mode is disabled",
      );
      await this.flushPendingAudioSegments("voice mode disabled");
      return;
    }

    const agentId = this.voiceModeAgentId;
    if (!agentId) {
      this.sessionLogger.warn(
        { requestId: result.requestId },
        "Skipping voice agent processing because no agent is currently voice-enabled",
      );
      await this.flushPendingAudioSegments("no active voice agent");
      return;
    }

    await this.routeUtterance(result.text);
  }

  /** Where a voice-mode utterance goes: the held message, a command, a card, or the agent. */
  private async routeUtterance(text: string): Promise<void> {
    // A message waiting out its hold: "cancel" drops it, other words send it first.
    if (await this.sendGate.settleHeldMessage(text)) {
      await this.flushPendingAudioSegments("held message settled");
      return;
    }

    // "Paseo, ..." asks the side helper. A navigation command after the name still moves voice.
    const sideCall = this.readSideHelperCall(text);
    if (sideCall) {
      if (sideCall.kind === "wake") {
        this.sideHelperWoken = true;
        this.queueAnnouncement(SIDE_HELPER_WAKE_SPEECH);
      } else if (sideCall.kind === "cancel") {
        this.queueAnnouncement(CANCELLED_SPEECH);
      } else if (
        !(
          this.navigationEnabled &&
          parseVoiceNavCommand(sideCall.question) &&
          (await this.handleNavigation(sideCall.question))
        )
      ) {
        this.startSideHelper(sideCall.question);
      }
      await this.flushPendingAudioSegments("side helper");
      return;
    }

    // "go to fitup", "list chats", "go back", or the chat picked after its name was read out.
    if (this.navigationEnabled && (await this.handleNavigation(text))) {
      await this.flushPendingAudioSegments("voice navigation");
      return;
    }

    // A pending question card takes the reply as its answer; sending it as chat would leave the card open.
    if (this.pendingQuestion && (await this.answerPendingQuestion(text))) {
      await this.flushPendingAudioSegments("answered question card");
      return;
    }

    // A permission prompt is answered on screen only. The words must not approve it or reach the
    // agent as chat.
    if (this.pendingPermissionIds.size > 0) {
      this.queueAnnouncement(buildPermissionReminderSpeech());
      await this.flushPendingAudioSegments("permission prompt waiting");
      return;
    }

    await this.sendGate.handleUtterance(text);
    await this.flushPendingAudioSegments("transcription complete");
  }

  /** Returns true when the utterance was a navigation command (or the reply to "Which one?"). */
  private async handleNavigation(transcript: string): Promise<boolean> {
    const command = parseVoiceNavCommand(transcript);
    const pick = this.pendingChatPick;
    this.pendingChatPick = null;
    if (!command) {
      if (!pick) return false;
      if (isCancelCommand(transcript)) {
        this.queueAnnouncement(CANCELLED_SPEECH);
        return true;
      }
      const chat = resolveChatPick(transcript, pick.chats);
      if (chat) this.moveVoiceTo({ project: pick, chat });
      else this.queueAnnouncement(NO_CHAT_SPEECH);
      return true;
    }

    let directory: VoiceChatProject[];
    try {
      directory = await this.host.listVoiceChats();
    } catch (error) {
      this.sessionLogger.warn({ err: error }, "Failed to list chats for a voice command");
      this.queueAnnouncement("I couldn't read your chats.");
      return true;
    }
    const here = findVoiceChat(directory, this.voiceModeAgentId);

    if (command.kind === "go_back") {
      const previous = findVoiceChat(directory, this.navMemory.previousAgentId);
      if (previous) this.moveVoiceTo(previous);
      else this.queueAnnouncement(NO_PREVIOUS_CHAT_SPEECH);
      return true;
    }

    if (command.kind === "list_chats") {
      if (!here) {
        this.queueAnnouncement("This chat is not in a project I know.");
        return true;
      }
      this.offerChats(here.project);
      return true;
    }

    const target = resolveGoToTarget(command.target, directory, here?.project.projectId ?? null);
    // "Go to the auth module and add logging" names no project or chat: it is talk for the agent.
    if (!target) return false;
    if (target.chat) {
      this.moveVoiceTo({ project: target.project, chat: target.chat });
      return true;
    }
    const chats = target.project.chats;
    if (chats.length === 1) this.moveVoiceTo({ project: target.project, chat: chats[0] });
    else this.offerChats(target.project);
    return true;
  }

  /** Reads the project's chat names and waits for a pick; one chat or none is just said. */
  private offerChats(project: VoiceChatProject): void {
    if (project.chats.length === 0) {
      this.queueAnnouncement(buildNoChatsSpeech(project));
      return;
    }
    if (project.chats.length === 1) {
      this.queueAnnouncement(buildOnlyChatSpeech(project, project.chats[0]));
      return;
    }
    this.pendingChatPick = project;
    this.queueAnnouncement(buildChatListSpeech(project));
  }

  /**
   * Asks the app to open the chat and turn voice on there. The app restarts voice for the new
   * chat, so the confirmation is spoken once voice is on there (`recordVoiceArrival`).
   */
  private moveVoiceTo(target: VoiceChatTarget): void {
    if (target.chat.agentId === this.voiceModeAgentId) {
      this.queueAnnouncement(buildAlreadyHereSpeech(target));
      return;
    }
    this.navMemory.arrival = { agentId: target.chat.agentId, speech: buildArrivedSpeech(target) };
    this.emit({
      type: "voice.navigate",
      payload: { agentId: target.chat.agentId, workspaceId: target.chat.workspaceId },
    });
  }

  /** Voice is on in `agentId`: remember where it came from and say where it is now. */
  private recordVoiceArrival(agentId: string): void {
    const memory = this.navMemory;
    if (memory.currentAgentId && memory.currentAgentId !== agentId) {
      memory.previousAgentId = memory.currentAgentId;
    }
    memory.currentAgentId = agentId;
    if (memory.arrival?.agentId === agentId) {
      this.queueAnnouncement(memory.arrival.speech);
    }
    memory.arrival = null;
  }

  /** The side question in this utterance, or null when the host has no side helper. */
  private readSideHelperCall(text: string): SideHelperCall | { kind: "cancel" } | null {
    if (!this.host.askSideHelper) return null;
    if (!this.sideHelperWoken) return parseSideHelperCall(text);
    // "Paseo." came alone; these words are the question, unless they call it off.
    this.sideHelperWoken = false;
    if (isCancelCommand(text)) return { kind: "cancel" };
    return parseSideHelperCall(text) ?? { kind: "question", question: text.trim() };
  }

  /**
   * Asks the side helper and speaks its answer; nothing reaches the chat. A slow answer gets
   * "One sec." first, and one that takes too long or fails gets "Sorry, no answer." A cancel
   * (voice off, abort, the next question) ends it silently.
   */
  private startSideHelper(question: string): void {
    const askSideHelper = this.host.askSideHelper?.bind(this.host);
    if (!askSideHelper) return;
    this.cancelSideHelper();
    const run = new AbortController();
    this.sideHelperRun = run;
    const timeout = new AbortController();
    let finished = false;
    const finish = (speech: string | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutTimer);
      clearTimeout(waitTimer);
      if (this.sideHelperRun === run) this.sideHelperRun = null;
      if (speech && !run.signal.aborted) this.queueAnnouncement(speech);
    };
    const timeoutTimer = setTimeout(() => {
      this.sessionLogger.warn({ question }, "Voice helper took too long");
      finish(SIDE_HELPER_FAILED_SPEECH);
      timeout.abort(new Error("The voice helper took too long"));
    }, SIDE_HELPER_TIMEOUT_MS);
    const waitTimer = setTimeout(
      () => this.queueAnnouncement(SIDE_HELPER_WAIT_SPEECH),
      SIDE_HELPER_WAIT_MS,
    );
    run.signal.addEventListener("abort", () => finish(null), { once: true });
    void (async () => {
      try {
        const answer = await askSideHelper({
          question,
          currentAgentId: this.voiceModeAgentId,
          signal: AbortSignal.any([run.signal, timeout.signal]),
        });
        finish(answer.trim() || SIDE_HELPER_FAILED_SPEECH);
      } catch (error) {
        if (!finished) this.sessionLogger.warn({ err: error, question }, "Voice helper failed");
        finish(SIDE_HELPER_FAILED_SPEECH);
      }
    })();
  }

  private cancelSideHelper(): void {
    this.sideHelperWoken = false;
    this.sideHelperRun?.abort(new Error("Voice helper question cancelled"));
    this.sideHelperRun = null;
  }

  private async deliverSpokenMessage(text: string): Promise<void> {
    const agentId = this.voiceModeAgentId;
    if (!agentId) {
      this.sessionLogger.warn("Dropping spoken message: no agent is voice-enabled");
      return;
    }
    await this.host.sendSpokenInput(agentId, text, {
      speakToolReady: !this.deferredVoicePrompt,
    });
  }

  private playSendCue(): void {
    this.ttsManager
      .playAudio(
        sendCuePcm(),
        SEND_CUE_FORMAT,
        (msg) => this.emit(msg),
        this.abortController.signal,
      )
      .catch((error) => this.sessionLogger.warn({ err: error }, "Failed to play the send cue"));
  }

  private reportSendError(error: unknown): void {
    this.sessionLogger.warn({ err: error }, "Failed to send spoken message");
    this.emit({
      type: "activity_log",
      payload: {
        id: uuidv4(),
        timestamp: new Date(),
        type: "error",
        content: `Could not send your message: ${getErrorMessage(error)}`,
      },
    });
  }

  private registerVoiceBridgeForAgent(agentId: string): void {
    this.registerVoiceSpeakHandler?.(agentId, async ({ text, signal }) => {
      this.sessionLogger.info(
        {
          agentId,
          textLength: text.length,
          preview: text.slice(0, 160),
        },
        "Voice speak tool call received by session handler",
      );
      const abortSignal = signal
        ? AbortSignal.any([signal, this.abortController.signal])
        : this.abortController.signal;
      const spokenText = prepareTextForSpeech(text);
      if (spokenText) {
        await this.playSpeech(spokenText, abortSignal);
      }
      this.sessionLogger.info(
        { agentId, textLength: text.length },
        "Voice speak tool call finished playback",
      );
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "assistant",
          content: text,
        },
      });
    });

    this.registerVoiceCallerContext?.(agentId, {
      childAgentDefaultLabels: {},
      allowCustomCwd: false,
      enableVoiceTools: true,
    });
  }

  /**
   * Speak text the agent did not send through the speak tool (a question card, a permission
   * prompt). Code and long paths are cut first; the chat log keeps the original.
   */
  private async speakAloud(text: string): Promise<void> {
    const spoken = prepareTextForSpeech(text);
    if (spoken) {
      await this.playSpeech(spoken, this.abortController.signal);
    }
    this.emit({
      type: "activity_log",
      payload: { id: uuidv4(), timestamp: new Date(), type: "assistant", content: text },
    });
  }

  /** Plays speech in voice mode; the VAD keeps its long window meanwhile so noise cannot cut it. */
  private async playSpeech(text: string, signal: AbortSignal): Promise<void> {
    this.activePlaybacks += 1;
    this.refreshSpeechConfirm();
    try {
      await this.ttsManager.generateAndWaitForPlayback(text, (msg) => this.emit(msg), signal, true);
    } finally {
      this.activePlaybacks -= 1;
      this.refreshSpeechConfirm();
    }
  }

  /**
   * The VAD confirm window. A short word ("cancel", "over", "go back", a chat name) lasts under the
   * default 800 ms, so it needs the short window to be heard at all. Short while a send-gate word is
   * expected, and, when the app can move voice, whenever no speech is playing.
   */
  private refreshSpeechConfirm(): void {
    const short = this.expectingShortWord || (this.navigationEnabled && this.activePlaybacks === 0);
    const confirmMs = short ? SHORT_WORD_CONFIRM_MS : null;
    if (confirmMs === this.appliedSpeechConfirmMs) return;
    this.appliedSpeechConfirmMs = confirmMs;
    this.voiceTurnController?.setSpeechConfirmMs(confirmMs);
  }

  /** Announcements play one after another so two prompts never talk over each other. */
  private queueAnnouncement(text: string): void {
    this.announcementChain = this.announcementChain
      .then(() => (this.closed ? undefined : this.speakAloud(text)))
      .catch((error) => {
        this.sessionLogger.warn({ err: error }, "Failed to speak voice announcement");
      });
  }

  /**
   * The agent asked the listener something. Read it aloud as written; for a question card, the
   * next spoken reply answers it (see `answerPendingQuestion`). Permission prompts are read but
   * answered on screen: a misheard "yes" must never approve a command.
   */
  announcePermissionRequest(agentId: string, request: AgentPermissionRequest): void {
    if (!this.isActiveForAgent(agentId) || this.announcedRequestIds.has(request.id)) {
      return;
    }
    this.announcedRequestIds.add(request.id);

    const questions = request.kind === "question" ? parseSpokenQuestions(request.input) : null;
    if (!questions) {
      this.pendingPermissionIds.add(request.id);
      this.queueAnnouncement(buildPermissionSpeech(request));
      return;
    }
    this.pendingQuestion = { agentId, request, questions, index: 0, answers: {} };
    this.queueAnnouncement(
      buildQuestionSpeech(questions[0], { index: 0, total: questions.length }),
    );
  }

  /** The card was answered or withdrawn somewhere else (the screen, another client, the agent). */
  handlePermissionResolved(agentId: string, requestId: string): void {
    this.pendingPermissionIds.delete(requestId);
    if (
      this.pendingQuestion?.agentId === agentId &&
      this.pendingQuestion.request.id === requestId
    ) {
      this.pendingQuestion = null;
    }
  }

  /** Returns true when the reply was spent on the pending question card instead of going to the agent as chat. */
  private async answerPendingQuestion(transcript: string): Promise<boolean> {
    const pending = this.pendingQuestion;
    if (!pending) {
      return false;
    }
    const question = pending.questions[pending.index];
    const total = pending.questions.length;
    const reply = interpretSpokenAnswer(question, transcript);

    if (reply.kind === "repeat") {
      this.queueAnnouncement(buildQuestionSpeech(question, { index: pending.index, total }));
      return true;
    }
    if (reply.kind === "unclear") {
      this.queueAnnouncement(buildUnclearAnswerSpeech(question));
      return true;
    }

    if (reply.kind === "answer") {
      pending.answers[question.header] = reply.answer;
      pending.index += 1;
      if (pending.index < total) {
        this.queueAnnouncement(
          buildQuestionSpeech(pending.questions[pending.index], { index: pending.index, total }),
        );
        return true;
      }
    }

    this.pendingQuestion = null;
    const response: AgentPermissionResponse =
      reply.kind === "answer"
        ? {
            behavior: "allow",
            updatedInput: { ...pending.request.input, answers: pending.answers },
          }
        : { behavior: "deny", message: "Dismissed by user" };
    try {
      await this.host.respondToPermission(pending.agentId, pending.request.id, response);
    } catch (error) {
      this.sessionLogger.warn(
        { err: error, agentId: pending.agentId, requestId: pending.request.id },
        "Failed to answer question card by voice",
      );
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Could not send your answer: ${getErrorMessage(error)}`,
        },
      });
    }
    return true;
  }

  /**
   * Stop TTS playback: abort the session's speak signal and release the waiting playbacks.
   */
  private stopPlayback(reason: string): void {
    this.abortController.abort();
    this.ttsManager.cancelPendingPlaybacks(reason);
  }

  private resetPhaseAfterAbort(): void {
    if (this.processingPhase === "transcribing") {
      // Still in STT phase - we'll buffer the next audio
      this.sessionLogger.debug("Will buffer next audio (currently transcribing)");
      // Phase stays as 'transcribing', handleAudioChunk will handle buffering
      return;
    }

    // Reset phase to idle and clear pending non-voice buffers.
    this.setPhase("idle");
    this.pendingAudioSegments = [];
    this.clearBufferTimeout();
  }

  /**
   * Handle abort request from client: the explicit Stop. Stops playback and interrupts the
   * agent's run. Detected speech does not come through here.
   */
  async handleAbort(): Promise<void> {
    this.sessionLogger.info(
      { phase: this.processingPhase },
      `Abort request, phase: ${this.processingPhase}`,
    );

    this.stopPlayback("abort request");

    if (this.isVoiceMode && this.voiceModeAgentId) {
      try {
        await this.host.interruptAgentIfRunning(this.voiceModeAgentId);
      } catch (error) {
        const message = `Voice interruption failed: ${getErrorMessage(error)}`;
        this.emit({
          type: "activity_log",
          payload: {
            id: uuidv4(),
            timestamp: new Date(),
            type: "error",
            content: message,
            metadata: { voiceAbortFailed: true },
          },
        });
        throw error;
      }
    }

    this.resetPhaseAfterAbort();
  }

  /**
   * Handle audio playback confirmation from client
   */
  handleAudioPlayed(id: string): void {
    this.ttsManager.confirmAudioPlayed(id);
  }

  /**
   * Speech detection start: stop TTS playback at once. The agent's run is not touched; only
   * an explicit abort request (handleAbort) interrupts it.
   */
  private handleVoiceSpeechStart(): void {
    if (this.speechInProgress) {
      return;
    }

    const chunkReceivedAt = Date.now();
    const phaseBeforeAbort = this.processingPhase;
    const hadActiveStream = this.host.hasActiveAgentRun(this.voiceModeAgentId);

    this.speechInProgress = true;
    this.sessionLogger.debug("Voice speech detected – stopping playback, agent run continues");

    if (this.pendingAudioSegments.length > 0) {
      this.sessionLogger.debug(
        { segmentCount: this.pendingAudioSegments.length },
        `Dropping ${this.pendingAudioSegments.length} buffered audio segment(s) due to voice speech`,
      );
      this.pendingAudioSegments = [];
    }

    if (this.audioBuffer) {
      this.sessionLogger.debug(
        { chunks: this.audioBuffer.chunks.length, pcmBytes: this.audioBuffer.totalPCMBytes },
        `Clearing partial audio buffer (${this.audioBuffer.chunks.length} chunk(s)${
          this.audioBuffer.isPCM ? `, ${this.audioBuffer.totalPCMBytes} PCM bytes` : ""
        })`,
      );
      this.audioBuffer = null;
    }

    this.clearBufferTimeout();

    this.stopPlayback("speech detected");
    this.resetPhaseAfterAbort();

    const latencyMs = Date.now() - chunkReceivedAt;
    this.sessionLogger.debug(
      { latencyMs, phaseBeforeAbort, hadActiveStream },
      "[Telemetry] barge_in.playback_stop_latency",
    );
  }

  /**
   * Clear speech-in-progress flag once the user turn has completed
   */
  private clearSpeechInProgress(reason: string): void {
    if (!this.speechInProgress) {
      return;
    }

    this.speechInProgress = false;
    this.sessionLogger.debug({ reason }, `Speech turn complete (${reason}) – resuming TTS`);
  }

  /**
   * Create new AbortController, aborting the previous one
   */
  private createAbortController(): AbortController {
    this.abortController.abort();
    this.abortController = new AbortController();
    this.ttsDebugStreams.clear();
    return this.abortController;
  }

  /**
   * Set the processing phase
   */
  private setPhase(phase: ProcessingPhase): void {
    this.processingPhase = phase;
    if (phase === "idle") this.onIdle?.();
    this.sessionLogger.debug({ phase }, `Phase: ${phase}`);
  }

  /**
   * Set timeout to process buffered audio segments
   */
  private setBufferTimeout(): void {
    this.clearBufferTimeout();

    this.bufferTimeout = setTimeout(async () => {
      this.sessionLogger.debug("Buffer timeout reached, processing pending segments");

      if (this.processingPhase === "transcribing") {
        this.sessionLogger.debug(
          { segmentCount: this.pendingAudioSegments.length },
          "Buffer timeout deferred because transcription is still in progress",
        );
        this.setBufferTimeout();
        return;
      }

      if (this.pendingAudioSegments.length > 0) {
        const segments = [...this.pendingAudioSegments];
        this.pendingAudioSegments = [];
        this.bufferTimeout = null;

        const combined = Buffer.concat(segments.map((s) => s.audio));
        await this.processAudio(combined, segments[0].format);
      }
    }, 10000); // 10 second timeout
  }

  /**
   * Clear buffer timeout
   */
  private clearBufferTimeout(): void {
    if (this.bufferTimeout) {
      clearTimeout(this.bufferTimeout);
      this.bufferTimeout = null;
    }
  }

  /**
   * Emit a message to the client. Captures TTS audio_output frames for optional
   * debug persistence before forwarding to the session emitter.
   */
  private emit(msg: SessionOutboundMessage): void {
    if (this.closed) return;
    if (
      msg.type === "audio_output" &&
      (process.env.TTS_DEBUG_AUDIO_DIR || isPaseoDictationDebugEnabled()) &&
      msg.payload.groupId &&
      typeof msg.payload.audio === "string"
    ) {
      const groupId = msg.payload.groupId;
      const existing =
        this.ttsDebugStreams.get(groupId) ??
        ({ format: msg.payload.format, chunks: [] } satisfies {
          format: string;
          chunks: Buffer[];
        });

      try {
        existing.chunks.push(Buffer.from(msg.payload.audio, "base64"));
        existing.format = msg.payload.format;
        this.ttsDebugStreams.set(groupId, existing);
      } catch {
        // ignore malformed base64
      }

      if (msg.payload.isLastChunk) {
        const final = this.ttsDebugStreams.get(groupId);
        this.ttsDebugStreams.delete(groupId);
        if (final && final.chunks.length > 0) {
          void (async () => {
            const recordingPath = await maybePersistTtsDebugAudio(
              Buffer.concat(final.chunks),
              { sessionId: this.sessionId, groupId, format: final.format },
              this.sessionLogger,
            );
            if (recordingPath) {
              this.host.emit({
                type: "activity_log",
                payload: {
                  id: uuidv4(),
                  timestamp: new Date(),
                  type: "system",
                  content: `Saved TTS audio: ${recordingPath}`,
                  metadata: { recordingPath, format: final.format, groupId },
                },
              });
            }
          })();
        }
      }
    }
    this.host.emit(msg);
  }

  /** Stop input synchronously, including a source disconnected during bootstrap. */
  cancel(): void {
    if (this.closed) return;
    this.closed = true;
    this.abortController.abort();
    this.cancelSideHelper();
    this.clearBufferTimeout();
    this.pendingAudioSegments = [];
    this.audioBuffer = null;
    const failures: unknown[] = [];
    for (const cleanup of [
      () => this.ttsManager.cleanup(),
      () => this.sttManager.cleanup(),
      () => this.dictationStreamManager.cleanupAll(),
    ]) {
      try {
        cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, "Voice input cleanup failed");
  }

  /** Restore the agent only after the caller has drained its in-flight requests. */
  async cleanup(): Promise<void> {
    try {
      this.cancel();
    } finally {
      try {
        await this.stopVoiceTurnController();
      } finally {
        await this.disableVoiceModeForActiveAgent(true);
        this.isVoiceMode = false;
      }
    }
  }
}
