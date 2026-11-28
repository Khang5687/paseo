import { VOICE_ACTIVE_ELSEWHERE_REASON_CODE } from "@getpaseo/protocol/voice";

/** True when the host refused voice because another device or tab already has it on for this chat. */
export function isVoiceActiveElsewhereError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "reasonCode" in error &&
    error.reasonCode === VOICE_ACTIVE_ELSEWHERE_REASON_CODE
  );
}
