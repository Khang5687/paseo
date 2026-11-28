# Voice side helper

How "Paseo, which chats are waiting on me?" gets a spoken answer from a separate model while the chat voice is in hears nothing. User-facing behavior is in `public-docs/voice.md`. This doc holds what the code can't tell you.

## Shape

- `VoiceSession.routeUtterance` checks for the name after a held message is settled and before navigation and question cards, so "Paseo, ..." works while a card or permission prompt waits. A navigation command after the name ("Paseo, go to fitup") still moves voice; anything else goes to `VoiceSessionHost.askSideHelper`.
- The answer is spoken with `queueAnnouncement`, the same path as "Cancelled." and the arrival speech. It emits only `activity_log` type `assistant`, which the app shows nowhere but errors, so the chat gets no message.
- `askSideHelper` is built in `session.ts` from `createVoiceSideHelper` (`packages/server/src/server/session/voice/voice-side-helper.ts`). It reads chats through the daemon's own managers (`readVoiceChats`, the same directory navigation uses, plus agent snapshots), not through MCP. A host without it (old test hosts) treats "Paseo, ..." as plain talk.
- The host advertises `server_info.features.voiceSideHelper`; the app shows the model row only then. Detection itself needs no app flag: no old app sends the words differently.

## Detection

The name must open the utterance and be followed by a pause. STT writes the pause as punctuation, so the rule is "name, then a punctuation mark". On this host Parakeet wrote "Paceo, what's going on in Fit Up?" for a spoken "Paseo, ..." and "Paceo app crashes when I open settings." when there was no pause. That is the only thing that keeps talk about the app out of the helper; do not loosen it to "starts with the name".

Spellings are compared after `soundsLike` (soft c and z as s, i and y as e, silent h, double letters once), with up to three words for the name ("Pass say oh") and an optional "hey"/"ok" in front. "Paseo." alone is a wake: "Yes?", and the next utterance is the question.

## Read-only guard

The model runs as a one-shot internal agent (`runSideHelperModel`): `internal: true`, no persisted session, an empty folder under the OS temp dir as its cwd, the provider's safe mode (`colorTier: "safe"`, OMP `ask`), every `permission_requested` denied (the same guard `ask_agent` copies use), and closed and deleted in `finally`. The chat data is sent inline in the prompt.

Residual risk: OMP's read tools are not approval-gated, so the model could read files under its empty cwd or by absolute path. It has nothing to change things with. Removing tools entirely (OMP `--no-tools`) needs a change in the OMP provider. A later action ("Paseo, tell fitup to run the tests") would be a new step that asks a spoken "yes" first, added in `voice-side-helper.ts`.

## Cost and time

- Context cap: `SIDE_HELPER_CONTEXT_TOKENS` = 6000 tokens, estimated at 4 characters each. Timelines get 60%: the current chat plus up to two chats the question names, last 12 items each, 600 characters per entry, newest kept. The chat list gets the rest, current chat and chats waiting on you first, then a "and N more" line.
- The internal agent still loads the provider's global context files and Paseo tools, which add input tokens the cap does not cover. The daemon log line `Voice helper call` has the real `inputTokens`, `outputTokens`, `costUsd` and `durationMs` for each question.
- "One sec." after 1.5 s, "Sorry, no answer." after 20 s or on any failure. Voice off, abort, or the next question cancels the run silently.
- The model is `features.voiceMode.sideHelperModel` (`<provider>/<model>`), read at every question. The default `omp/anthropic/claude-haiku-5-5` is provisional.

## Checking it again

Needs a built daemon (`npm run build:server`), the local speech models, and OMP logged in on the host. Start the isolated daemon as in [voice-send.md](voice-send.md#checking-it-again), with `agents.providers.omp.enabled: true` in its config.

1. Create `mock` agents in two or three folders and title them (`updateAgent(id, { name })`). Give one a timeline with a known fact (send it a message; the mock replies), and leave one with a pending permission if you want the "waiting on me" answer to name it.
2. Turn voice on in one chat and stream mic audio with Kokoro clips spliced in, as in voice-navigate.md. Ask "Paseo, which chats are waiting on me?", "Paseo, what's going on in <project>?" and "Paseo, what did the agent just say?".
3. Expect each answer as an `activity_log` `assistant` event with the right facts, no `user_message` in the chat voice is in, and a `Voice helper call` line per question in `$PASEO_HOME/daemon.log`. Then say a plain sentence; it beeps and reaches the chat.
4. In the web app at 390x844, **Settings > Voice** shows the **Answers "Paseo, …"** row with Haiku 5.5 and Sonnet 5.5; tapping one writes `features.voiceMode.sideHelperModel` to the host's `config.json`.

Keep live runs short: each question is one paid model call.
