import pino from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

const { openAiConstructorOptionsMock, speechCreateMock } = vi.hoisted(() => ({
  openAiConstructorOptionsMock: vi.fn(),
  speechCreateMock: vi.fn(),
}));

vi.mock("openai", () => ({
  OpenAI: vi.fn(function OpenAI(options: unknown) {
    openAiConstructorOptionsMock(options);
    return {
      audio: {
        speech: {
          create: speechCreateMock,
        },
      },
    };
  }),
}));

import { OpenAITTS } from "./tts.js";

describe("OpenAITTS", () => {
  afterEach(() => {
    openAiConstructorOptionsMock.mockReset();
    speechCreateMock.mockReset();
  });

  test("passes configured baseUrl to the OpenAI client", () => {
    const provider = new OpenAITTS(
      { apiKey: "sk-test", baseUrl: "https://speech.example.com/v1" },
      pino({ level: "silent" }),
    );

    expect(provider.getConfig().baseUrl).toBe("https://speech.example.com/v1");
    expect(openAiConstructorOptionsMock).toHaveBeenCalledWith({
      apiKey: "sk-test",
      baseURL: "https://speech.example.com/v1",
    });
  });

  test("passes the read-back speed to OpenAI, kept inside the range it accepts", async () => {
    speechCreateMock.mockResolvedValue({ arrayBuffer: async () => new ArrayBuffer(2) });
    const provider = new OpenAITTS({ apiKey: "sk-test" }, pino({ level: "silent" }));

    await provider.synthesizeSpeech("hello", { speed: 1.2 });
    await provider.synthesizeSpeech("hello", { speed: 9 });
    await provider.synthesizeSpeech("hello");

    expect(speechCreateMock.mock.calls.map(([request]) => request.speed)).toEqual([
      1.2,
      4,
      undefined,
    ]);
  });
});
