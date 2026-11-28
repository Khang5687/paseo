import { v4 as uuidv4 } from "uuid";
import type { AgentPermissionRequest } from "../../agent/agent-sdk-types.js";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { OwnedOperation, SessionDelivery } from "../owned-subscriptions/index.js";
import { VoiceSession, type VoiceSessionOptions } from "./voice-session.js";
import {
  createVoiceNavMemory,
  type VoiceFindChatsAnswer,
  type VoiceFindChatsQuery,
  type VoiceNavMemory,
} from "./voice-navigate.js";

/** How long a voice command waits for the app to say what its other hosts have. */
export const FIND_CHATS_TIMEOUT_MS = 3000;

type VoiceMessage = Extract<
  SessionInboundMessage,
  {
    type:
      | "voice_audio_chunk"
      | "abort_request"
      | "audio_played"
      | "set_voice_mode"
      | "voice.navigate.find_chats.response"
      | "dictation_stream_start"
      | "dictation_stream_chunk"
      | "dictation_stream_finish"
      | "dictation_stream_cancel";
  }
>;

type FindChatsResponse = Extract<VoiceMessage, { type: "voice.navigate.find_chats.response" }>;

interface ActiveVoiceSource {
  voice: VoiceSession;
  owner: OwnedOperation;
  pending: Set<Promise<void>>;
  closing: boolean;
}

/** Audio conversations belong to their requesting socket, including bootstrap and finalization. */
export class VoiceSessions {
  private readonly sources = new Map<object, ActiveVoiceSource>();
  /** Outlives each socket's voice session: moving to another chat starts a new one. */
  private readonly navMemory = new WeakMap<object, VoiceNavMemory>();
  /** Questions to the app about its other hosts, by request id. */
  private readonly findChatsRequests = new Map<
    string,
    {
      source: object;
      resolve: (answer: VoiceFindChatsAnswer | null) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(
    private readonly options: VoiceSessionOptions,
    private readonly delivery: SessionDelivery,
    private readonly demandChanged: () => void,
  ) {}

  get hasDemand(): boolean {
    return [...this.sources.values()].some((source) => !source.closing);
  }

  isActiveForAgent(agentId: string): boolean {
    return [...this.sources.values()].some(
      (source) => !source.closing && source.voice.isActiveForAgent(agentId),
    );
  }

  /** The agent asked the listener a question or for permission: read it aloud on the socket that has voice on. */
  announcePermissionRequest(agentId: string, request: AgentPermissionRequest): void {
    for (const source of this.sources.values()) {
      if (!source.closing && source.voice.isActiveForAgent(agentId)) {
        source.voice.announcePermissionRequest(agentId, request);
      }
    }
  }

  handlePermissionResolved(agentId: string, requestId: string): void {
    for (const source of this.sources.values()) {
      source.voice.handlePermissionResolved(agentId, requestId);
    }
  }

  handleMessage(message: VoiceMessage): Promise<void> {
    const source = this.delivery.currentSource;
    if (!source) throw new Error("Voice request has no source");
    // An answer to a question this daemon asked: it never starts a voice session.
    if (message.type === "voice.navigate.find_chats.response") {
      this.answerFindChats(source, message);
      return Promise.resolve();
    }
    const existing = this.sources.get(source);
    if (existing?.closing) return existing.owner.release().then(() => this.handleMessage(message));
    const active = existing ?? this.startSource(source);
    const pending = Promise.resolve().then(() => {
      return active.closing ? undefined : this.dispatch(active.voice, message);
    });
    active.pending.add(pending);
    const finished = () => {
      active.pending.delete(pending);
      this.releaseIdle(active);
      return undefined;
    };
    void pending.then(finished, finished);
    return pending;
  }

  private startSource(source: object): ActiveVoiceSource {
    const owner = this.delivery.operation(isVoiceOutput, async () => {
      active.closing = true;
      this.demandChanged();
      // Cancel input immediately; restore agent configuration after bootstrap has settled.
      try {
        active.voice.cancel();
      } finally {
        await Promise.allSettled(active.pending);
        await active.voice.cleanup();
      }
      if (this.sources.get(source) === active) this.sources.delete(source);
    });
    const active: ActiveVoiceSource = {
      owner,
      pending: new Set(),
      closing: false,
      voice: new VoiceSession({
        ...this.options,
        host: {
          ...this.options.host,
          emit: (message) => owner.emit(message),
          findChatsOnOtherHosts: (query) => this.askAppForChats(source, owner, query),
        },
        onIdle: () => this.releaseIdle(active),
        navMemory: this.navMemoryFor(source),
      }),
    };
    this.sources.set(source, active);
    this.demandChanged();
    return active;
  }

  private navMemoryFor(source: object): VoiceNavMemory {
    const existing = this.navMemory.get(source);
    if (existing) return existing;
    const created = createVoiceNavMemory();
    this.navMemory.set(source, created);
    return created;
  }

  /** Asks the socket's app which of its other hosts has the name or chat; null after the timeout. */
  private askAppForChats(
    source: object,
    owner: OwnedOperation,
    query: VoiceFindChatsQuery,
  ): Promise<VoiceFindChatsAnswer | null> {
    const requestId = uuidv4();
    // The server's lib predates Promise.withResolvers.
    return new Promise((resolve) => {
      const timeout = setTimeout(
        () => this.settleFindChats(requestId, null),
        FIND_CHATS_TIMEOUT_MS,
      );
      this.findChatsRequests.set(requestId, { source, resolve, timeout });
      owner.emit({ type: "voice.navigate.find_chats.request", payload: { requestId, query } });
    });
  }

  private settleFindChats(requestId: string, answer: VoiceFindChatsAnswer | null): void {
    const request = this.findChatsRequests.get(requestId);
    if (!request) return;
    clearTimeout(request.timeout);
    this.findChatsRequests.delete(requestId);
    request.resolve(answer);
  }

  private answerFindChats(source: object, message: FindChatsResponse): void {
    const request = this.findChatsRequests.get(message.payload.requestId);
    if (request?.source !== source) return;
    this.settleFindChats(message.payload.requestId, {
      hostName: message.payload.hostName,
      matches: message.payload.matches,
    });
  }

  private releaseIdle(source: ActiveVoiceSource): void {
    if (source.closing || source.pending.size > 0 || source.voice.hasDemand) return;
    void source.owner
      .release()
      .catch((error) =>
        this.options.logger.error({ err: error }, "Failed to release voice source"),
      );
  }

  private async dispatch(voice: VoiceSession, message: VoiceMessage): Promise<void> {
    switch (message.type) {
      case "voice_audio_chunk":
        return voice.handleAudioChunk(message);
      case "abort_request":
        return voice.handleAbort();
      case "audio_played":
        return voice.handleAudioPlayed(message.id);
      case "set_voice_mode":
        return voice.handleSetVoiceMode(message.enabled, message.agentId, message.requestId, {
          navigation: message.navigation === true,
          navigationHosts: message.navigationHosts === true,
          arrival: message.arrival,
        });
      case "voice.navigate.find_chats.response":
        return;
      case "dictation_stream_start":
        return voice.handleDictationStreamStart(message);
      case "dictation_stream_chunk":
        return voice.handleDictationChunk({
          dictationId: message.dictationId,
          seq: message.seq,
          audioBase64: message.audio,
          format: message.format,
        });
      case "dictation_stream_finish":
        return voice.handleDictationFinish(message.dictationId, message.finalSeq);
      case "dictation_stream_cancel":
        return voice.handleDictationCancel(message.dictationId);
    }
  }
}

function isVoiceOutput(message: SessionOutboundMessage): boolean {
  switch (message.type) {
    case "audio_output":
    case "transcription_result":
    case "voice_input_state":
    case "voice.navigate":
    case "voice.navigate.find_chats.request":
    case "set_voice_mode_response":
    case "dictation_stream_ack":
    case "dictation_stream_partial":
    case "dictation_stream_final":
    case "dictation_stream_error":
    case "dictation_stream_finish_accepted":
    case "activity_log":
      return true;
    default:
      return false;
  }
}
