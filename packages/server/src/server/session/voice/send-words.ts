// The spoken send words: "over" ends a message in over mode, "cancel" drops the message that
// is about to go. Both are English only and matched on the transcript, so case and
// punctuation never matter. Whisper-style STT writes "Over." or "Cancel!", never the bare word.

export const VOICE_SEND_MODES = ["auto", "over"] as const;

/**
 * `auto`: a finished utterance (1 s of quiet) is the message. `over`: utterances collect until
 * one ends with the word "over".
 */
export type VoiceSendMode = (typeof VOICE_SEND_MODES)[number];

export function parseVoiceSendMode(value: unknown): VoiceSendMode {
  return value === "over" ? "over" : "auto";
}

// "over" as the last word: a word boundary before it, nothing but punctuation after it. Commas
// and dashes in front of it go with it; a full stop stays with the sentence it ends.
const TRAILING_OVER =
  /^([\s\S]*?)[\s,;:\u2013\u2014-]*(?<![\p{L}\p{N}'\u2019])over[\s.!?,;:\u2026]*$/iu;

/**
 * Splits off a closing "over". `over` is true only when "over" is the last word of the
 * utterance; "go over the plan", "overall" and "hangover" stay plain text.
 */
export function takeOverWord(transcript: string): { over: boolean; text: string } {
  const trimmed = transcript.trim();
  const match = TRAILING_OVER.exec(trimmed);
  if (!match) return { over: false, text: trimmed };
  return { over: true, text: match[1].trim() };
}

const CANCEL_COMMAND = /^(?:please )?cancel(?: (?:it|that|this|the message))?(?: please)?$/;

/** The whole utterance is "cancel" (or "cancel that"); "cancel" inside a sentence is plain text. */
export function isCancelCommand(transcript: string): boolean {
  const words = transcript
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return CANCEL_COMMAND.test(words);
}
