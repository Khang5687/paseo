import { isCancelCommand, takeOverWord, type VoiceSendMode } from "./send-words.js";

/**
 * How long a finished message waits after the send beep before it goes to the agent. Saying
 * "cancel" in this window drops it. 2 s covers hearing the beep (~0.3 s), starting to speak
 * (~0.5-1 s) and the short-word speech confirm (0.3 s); speech that starts inside the window
 * holds the message until that speech is transcribed, so a slow STT never sends it early.
 */
export const VOICE_SEND_HOLD_MS = 2000;

/**
 * Speech confirm window while a short word is expected (a held message, or over mode with
 * text waiting). The normal 800 ms never confirms a lone "over" (~0.7 s) or "cancel" (~0.8 s),
 * measured with Kokoro clips through the Silero VAD.
 */
export const SHORT_WORD_CONFIRM_MS = 300;

export const CANCELLED_SPEECH = "Cancelled.";
export const NOTHING_TO_CANCEL_SPEECH = "Nothing to cancel.";

export interface VoiceSendGateDeps {
  getMode(): VoiceSendMode;
  /** Deliver a message to the agent. */
  send(text: string): Promise<void>;
  /** The short beep that says "about to send". */
  playSendCue(): void;
  /** A short spoken confirmation ("Cancelled."). */
  speak(text: string): void;
  /** `true` while a short word ("over", "cancel") may come next. */
  setExpectingShortWord(expecting: boolean): void;
  onSendError(error: unknown): void;
}

interface HeldMessage {
  text: string;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** The hold window is over; the message goes once no transcript is pending. */
  expired: boolean;
  /** Speech started during the hold; the message waits for its transcript. */
  heardSpeech: boolean;
}

/**
 * Decides when a spoken utterance becomes a message for the agent: the send mode ("over"),
 * the beep, the hold and "cancel". Owns no audio; the voice session feeds it speech starts
 * and transcripts.
 */
export class VoiceSendGate {
  private readonly deps: VoiceSendGateDeps;
  /** Over mode: utterances said so far, waiting for "over". */
  private waiting: string[] = [];
  private held: HeldMessage | null = null;
  private expectingShortWord = false;

  constructor(deps: VoiceSendGateDeps) {
    this.deps = deps;
  }

  get hasHeldMessage(): boolean {
    return this.held !== null;
  }

  /** Detected speech: a held message now waits for what this speech turns out to be. */
  handleSpeechStarted(): void {
    if (this.held) this.held.heardSpeech = true;
  }

  /**
   * First look at every transcript, before question cards or chat. Returns true when the
   * transcript is used up: "cancel" dropped the held message, or it was noise.
   */
  async settleHeldMessage(transcript: string): Promise<boolean> {
    const held = this.held;
    if (!held) return false;
    if (isCancelCommand(transcript)) {
      this.dropHeld();
      this.deps.speak(CANCELLED_SPEECH);
      return true;
    }
    if (!transcript.trim()) {
      held.heardSpeech = false;
      if (held.expired) await this.release();
      return true;
    }
    // New words while the message waits: the message goes now, the new words start the next one.
    await this.release();
    return false;
  }

  /** A transcript that is not an answer to a question card: chat, "over" or "cancel". */
  async handleUtterance(transcript: string): Promise<void> {
    const text = transcript.trim();
    if (!text) return;
    if (isCancelCommand(text)) {
      if (this.waiting.length > 0) {
        this.waiting = [];
        this.deps.speak(CANCELLED_SPEECH);
      } else {
        this.deps.speak(NOTHING_TO_CANCEL_SPEECH);
      }
      this.refreshShortWord();
      return;
    }

    if (this.deps.getMode() === "over") {
      const { over, text: rest } = takeOverWord(text);
      if (rest) this.waiting.push(rest);
      if (over && this.waiting.length > 0) {
        this.hold(this.takeWaiting());
        return;
      }
      this.refreshShortWord();
      return;
    }

    // Text left from over mode (the setting changed mid-message) goes with this message.
    this.waiting.push(text);
    this.hold(this.takeWaiting());
  }

  /**
   * Voice is turning off. A held message was already confirmed (beep played), so it goes now;
   * text still waiting for "over" was never confirmed and is dropped.
   */
  async flush(): Promise<void> {
    this.waiting = [];
    if (this.held) await this.release();
    this.refreshShortWord();
  }

  /** Session closed: nothing more is sent. */
  dispose(): void {
    this.waiting = [];
    clearTimeout(this.held?.timer);
    this.held = null;
  }

  private takeWaiting(): string {
    const message = this.waiting.join(" ");
    this.waiting = [];
    return message;
  }

  private hold(text: string): void {
    const held: HeldMessage = { text, timer: undefined, expired: false, heardSpeech: false };
    held.timer = setTimeout(() => {
      held.expired = true;
      if (this.held === held && !held.heardSpeech) {
        this.release().catch((error) => this.deps.onSendError(error));
      }
    }, VOICE_SEND_HOLD_MS);
    this.held = held;
    this.deps.playSendCue();
    this.refreshShortWord();
  }

  private dropHeld(): void {
    clearTimeout(this.held?.timer);
    this.held = null;
    this.refreshShortWord();
  }

  private async release(): Promise<void> {
    const held = this.held;
    if (!held) return;
    clearTimeout(held.timer);
    this.held = null;
    this.refreshShortWord();
    await this.deps.send(held.text);
  }

  private refreshShortWord(): void {
    const expecting =
      this.held !== null || (this.deps.getMode() === "over" && this.waiting.length > 0);
    if (expecting === this.expectingShortWord) return;
    this.expectingShortWord = expecting;
    this.deps.setExpectingShortWord(expecting);
  }
}
