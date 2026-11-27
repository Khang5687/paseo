# Voice read-back

What Voice mode says on its own, besides what the agent passes to `speak`: question cards, permission prompts, and the text cleaning that every spoken string goes through. User-facing behavior is in `public-docs/voice.md`. This doc holds what the code can't tell you.

## Shape

- `VoiceSession` (`packages/server/src/server/session/voice/voice-session.ts`) reads a prompt the moment `session.ts` sees `permission_requested`. The agent does not have to call `speak`. Read-backs share one chain, so two prompts never talk over each other.
- A pending question card makes the next transcript an answer, not chat. The answer goes out through `agentManager.respondToPermission`, the same call the app's card uses, keyed by the question `header`.
- While a card is pending, barge-in does not interrupt the agent. The run is blocked on that card; interrupting it drops the card and the spoken answer arrives as chat with nothing left to answer.
- Permission prompts that are not question cards are read only. A misheard "yes" must never allow a command. The prompt stays pending while it waits (`pendingPermissionIds`): speech does not interrupt the run, does not reach the agent as chat, and gets a spoken reminder ("A permission prompt is waiting. Answer it on screen."). Interrupting would drop the prompt, and chat would give the listener a second turn the agent never asked for. `permission_resolved` clears it.
- Everything spoken goes through `prepareTextForSpeech` (`speech-text.ts`). Activity-log entries keep the original text.
- A second device gets `reasonCode: "voice_active_elsewhere"` on `set_voice_mode_response`. The app maps it to a translated message. An old daemon sends only the raw text; the app shows that.

## Checking it again

Needs a built daemon (`npm run build:server`), the local speech models in `~/.paseo/models/local-speech`, and a free port.

1. Start an isolated daemon: own `PASEO_HOME`, `PASEO_LISTEN=127.0.0.1:<port>`, `PASEO_RELAY_ENABLED=false`, `PASEO_VOICE_MODE_ENABLED=1`, and `daemon.mcp.injectIntoAgents: true` in its `config.json`. Run it as a supervised service, not a background job of your shell: the shell kills background jobs when the call ends, and the dev runner exits on that SIGTERM.
2. With `DaemonClient` (from `test-utils/daemon-client`), create a `mock` agent (`modeId: "load-test"`) and call `setVoiceMode(true, agentId)`.
3. Send `emit synthetic questions` (a 3-question card: two with options, one free text), `emit synthetic questions with links` (URLs and a Markdown link in the text) or `emit synthetic plan approval` (a plain permission prompt).
4. Collect `audio_output` frames and ack each with `audioPlayed(id)`. TTS splits text per sentence, so one question arrives as several groups. Wait until the audio has been quiet for a few seconds before you answer.
5. Answer by sending speech: synthesize a clip with `SherpaOnnxTTS`, add 0.5 s of silence before and 1.6 s after, and send it with `sendVoiceAudioChunk` (`audio/pcm;rate=24000;bits=16`).
6. Expect: each question read once, the answer heard in `transcription_result`, the agent `running` until the last answer, then `pendingPermissions` empty and the agent `idle`. For the plan prompt, expect the read-back; then speak, and expect the reminder "A permission prompt is waiting. Answer it on screen.", the prompt still in `pendingPermissions`, the agent still `running`, and nothing sent to the agent.
7. To hear what was spoken, write the captured PCM as a WAV and run `npm run speech:transcribe:local -- <file.wav>` in `packages/server`.

Two devices: hold voice on from a script client, open the web app at 390×844 on the same chat, tap Enable Voice mode. Expect "Voice is on for this chat on another device". The red "Failed to start voice mode" box under the composer is the dev-build console overlay and does not show in release builds.

Gotchas:

- A Metro dev server reuses the browser profile's `localStorage` for its origin. A stale host registry shows "Host is not connected"; clear storage and reload.
- Only the `speak` tool path needs a real agent that can call MCP tools. The mock provider never calls it, so the tool path is covered by `voice-session.readback.test.ts`, not by this route.
