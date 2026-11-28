import { describe, expect, it } from "vitest";
import { SetVoiceModeRejectedError } from "@getpaseo/client/internal/daemon-client";
import { isVoiceActiveElsewhereError } from "./voice-start-error";

describe("isVoiceActiveElsewhereError", () => {
  it("recognises the host's refusal for a chat that has voice on another device", () => {
    const error = new SetVoiceModeRejectedError(
      "Voice mode is already active for this agent (voice_active_elsewhere)",
      "voice_active_elsewhere",
    );
    expect(isVoiceActiveElsewhereError(error)).toBe(true);
  });

  it("leaves other refusals and plain errors alone", () => {
    expect(
      isVoiceActiveElsewhereError(
        new SetVoiceModeRejectedError("Models missing", "models_missing"),
      ),
    ).toBe(false);
    expect(isVoiceActiveElsewhereError(new SetVoiceModeRejectedError("Old host", undefined))).toBe(
      false,
    );
    expect(isVoiceActiveElsewhereError(new Error("boom"))).toBe(false);
    expect(isVoiceActiveElsewhereError("voice_active_elsewhere")).toBe(false);
  });
});
