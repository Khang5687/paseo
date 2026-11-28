import { EventEmitter } from "node:events";
import pino from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { SessionOutboundMessage } from "../../messages.js";
import { SessionDelivery } from "../owned-subscriptions/index.js";
import { FIND_CHATS_TIMEOUT_MS, FindChatsRequests, VoiceSessions } from "./index.js";
import type { StreamingTranscriptionSession } from "../../speech/speech-provider.js";

test("a failed speech close reports the failure without retaining observation demand", async () => {
  class BrokenCloseStream extends EventEmitter implements StreamingTranscriptionSession {
    readonly requiredSampleRate = 16000;
    async connect() {}
    appendPcm16() {}
    commit() {}
    clear() {}
    close() {
      throw new Error("Speech worker close failed");
    }
  }
  const source = {};
  const delivery = new SessionDelivery(() => {});
  delivery.attach(source, true);
  const demands: boolean[] = [];
  const voice = new VoiceSessions(
    {
      sessionId: "failed-speech-close",
      logger: pino({ level: "silent" }),
      host: {
        emit() {},
        async loadAgent() {
          throw new Error("Unexpected agent load");
        },
        speakToolUnavailableReason: () => null,
        async reloadAgentSession() {
          throw new Error("Unexpected agent reload");
        },
        async sendSpokenInput() {
          throw new Error("Unexpected spoken input");
        },
        async interruptAgentIfRunning() {},
        hasActiveAgentRun: () => false,
        async waitForAgentIdle() {},
      },
      stt: null,
      tts: null,
      dictation: { stt: { id: "local", createSession: () => new BrokenCloseStream() } },
    },
    delivery,
    () => demands.push(voice.hasDemand),
  );
  const request = {
    type: "dictation_stream_start" as const,
    dictationId: "recording",
    format: "audio/pcm;rate=16000;bits=16",
  };
  await delivery.request(source, request, () => voice.handleMessage(request));
  expect(voice.hasDemand).toBe(true);
  await expect(delivery.detach(source)).rejects.toThrow();
  expect(voice.hasDemand).toBe(false);
  expect(demands.at(-1)).toBe(false);
});

describe("asking the app for chats on its other hosts", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function requestIdOf(message: SessionOutboundMessage | undefined): string {
    if (message?.type !== "voice.navigate.find_chats.request") throw new Error("No request sent");
    return message.payload.requestId;
  }

  test("no answer in time goes on with this host's chats only", async () => {
    vi.useFakeTimers();
    const requests = new FindChatsRequests();
    const asked = requests.ask({}, () => {}, { kind: "name", target: "groceries" });
    let answer: unknown = "pending";
    void asked.then((value) => {
      answer = value;
      return value;
    });
    await vi.advanceTimersByTimeAsync(FIND_CHATS_TIMEOUT_MS - 1);
    expect(answer).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(answer).toBeNull();
  });

  test("only the socket that was asked can answer", async () => {
    vi.useFakeTimers();
    const requests = new FindChatsRequests();
    const appSocket = {};
    const sent: SessionOutboundMessage[] = [];
    const asked = requests.ask(appSocket, (message) => sent.push(message), {
      kind: "name",
      target: "groceries",
    });
    const requestId = requestIdOf(sent[0]);
    requests.answer({}, { requestId, hostName: "Intruder", matches: [] });
    requests.answer(appSocket, { requestId, hostName: "Omen", matches: [] });
    await expect(asked).resolves.toEqual({ hostName: "Omen", matches: [] });
  });
});
