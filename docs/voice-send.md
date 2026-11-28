# Voice send

How Voice mode decides that a spoken message is finished and sends it: the two send modes, the beep, the 2 s hold and the spoken "cancel". User-facing behavior is in `public-docs/voice.md`. This doc holds what the code can't tell you.

## Shape

- The gate lives on the daemon (`VoiceSendGate` in `packages/server/src/server/session/voice/send-gate.ts`), so an app that predates it still gets the behavior. The app only shows the setting.
- The send mode is the host setting `features.voiceMode.sendMode` (`auto` or `over`), read on every utterance. Changing it must not rebuild the speech providers: a rebuild restarts the local speech worker and the live voice session stops hearing. `SPEECH_LIVE_PATHS` in `daemon-config-store.ts` keeps it out of the rebuild.
- The app row is gated on `server_info.features.voiceSendMode`. Old hosts hide it.
- The beep is built on the daemon (`send-cue.ts`) and goes out as a normal `audio_output` frame with `isVoiceMode: true`, so old apps play it too. The 2 s hold starts when the beep is sent, not when it finishes playing.
- Speech that starts inside the hold keeps the message until its transcript arrives. A whole-utterance "cancel" drops it; anything else sends it at once and starts a new message. "cancel" inside a sentence is plain text.
- Command words are English only and must be the whole utterance (after "over" is stripped in over mode). Matching is in `send-words.ts`.
- Turning voice off sends a held message and drops over-mode text that never got its "over".

## Short words and the VAD

Silero VAD confirms speech only after it lasts `speechConfirmMs` (800 ms by default). A lone "over" (about 0.7 s) or "cancel" (about 0.8 s) never reaches that, so the turn is never started. The session drops the window to 300 ms (`SHORT_WORD_CONFIRM_MS`) through `setSpeechConfirmMs`, which reaches the worker's VAD session, while a short word is expected: a message is held, or over-mode text is waiting. When the app can move voice between chats ([voice-navigate.md](voice-navigate.md)) it also stays at 300 ms whenever no speech is playing, because "go back" or a chat name can come at any time. While speech plays it is 800 ms so noise does not barge in on playback. `VoiceSession.refreshSpeechConfirm` owns the rule.

A lone "cancel" said when nothing is held may therefore not be heard at all. That is fine as long as it is dropped: `voice-turn-controller.ts` keeps only the last 1.5 s of listening audio for STT (`STT_PREROLL_MS`) and streams the rest only once the VAD confirms speech. Before that change, every sound the VAD rejected stayed in the STT buffer and was glued onto the next message ("Cancel cancel cancel the build...").

## Checking it again

Needs a built daemon (`npm run build:server`), the local speech models in `~/.paseo/models/local-speech`, and a free port.

1. Start an isolated daemon as a supervised service: own `PASEO_HOME`, `PASEO_LISTEN=127.0.0.1:<port>`, `PASEO_RELAY_ENABLED=false`, `PASEO_VOICE_MODE_ENABLED=1`, `PASEO_NODE_ENV=development` (the `mock` provider needs it), and `PASEO_LOCAL_MODELS_DIR=$HOME/.paseo/models/local-speech`. See [voice-readback.md](voice-readback.md#checking-it-again) for why it must be a service.
2. With `DaemonClient` (from `test-utils/daemon-client`), create a `mock` agent with `modeId: "load-test"` and `model: "e2e-fast-stream"`, so each message starts its own turn and shows in the timeline as a `user_message`. Set `patchDaemonConfig({ features: { voiceMode: { sendMode } } })`, then `setVoiceMode(true, agentId)`.
3. Stream microphone audio without gaps: 100 ms frames of `audio/pcm;rate=24000;bits=16` in real time, silence when nobody talks. Splice speech clips synthesized with `SherpaOnnxTTS` into that stream. Without continuous silence after a clip the VAD never ends the turn.
4. Watch `audio_output`: the beep is one group of 0.16 s; spoken replies are longer. Ack every group with `audioPlayed(id)`. Poll `fetchAgentTimeline(agentId, { direction: "tail" })` for `user_message` items; their text sits inside `<spoken-input>`.
5. Expect, in auto mode: a beep about 1 s after the clip ends, the message in the timeline about 2 s after the beep; "Cancel." said about 0.5 s after the beep drops it and the voice says "Cancelled."; "Cancel." 2.6 s after the beep is too late and the message stays sent; "The game is over." is sent as text. In over mode: "Let's go over the plan." gives no beep; "Then fix the tests, over." sends both utterances joined, without "over"; "Cancel." after that beep drops it.
