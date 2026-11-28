# Voice side helper

How "Paseo, which chats are waiting on me?" gets a spoken answer from a separate model while the chat voice is in hears nothing, and how "Paseo, tell fitup to run the tests" runs only after a spoken yes. User-facing behavior is in `public-docs/voice.md`. This doc holds what the code can't tell you.

## Shape

- `VoiceSession.routeUtterance` checks for the name after a held message is settled and before navigation and question cards, so "Paseo, ..." works while a card or permission prompt waits. A navigation command after the name ("Paseo, go to fitup") still moves voice; anything else goes to `VoiceSessionHost.askSideHelper`.
- The answer is spoken with `queueAnnouncement`, the same path as "Cancelled." and the arrival speech. It emits only `activity_log` type `assistant`, which the app shows nowhere but errors, so the chat gets no message.
- `askSideHelper` returns a `SideHelperReply`: speech, a read-back to confirm, or "Which X chat?". `VoiceSession` keeps one `helperPending` step for the last two and runs the action through `VoiceSessionHost.runSideHelperAction`.
- `askSideHelper` is built in `session.ts` from `createVoiceSideHelper` (`packages/server/src/server/session/voice/voice-side-helper.ts`). It reads chats through the daemon's own managers (`readVoiceChats`, the same directory navigation uses, plus agent snapshots), not through MCP. A host without it (old test hosts) treats "Paseo, ..." as plain talk.
- The host advertises `server_info.features.voiceSideHelper`; the app shows the model row only then. Detection itself needs no app flag: no old app sends the words differently.

## Detection

The name must open the utterance and be followed by a pause. STT writes the pause as punctuation, so the rule is "name, then a punctuation mark". On this host Parakeet wrote "Paceo, what's going on in Fit Up?" for a spoken "Paseo, ..." and "Paceo app crashes when I open settings." when there was no pause. That is the only thing that keeps talk about the app out of the helper; do not loosen it to "starts with the name".

Spellings are compared after `soundsLike` (soft c and z as s, i and y as e, silent h, double letters once), with up to three words for the name ("Pass say oh") and an optional "hey"/"ok" in front. "Paseo." alone is a wake: "Yes?", and the next utterance is the question.

## Model guard

The model runs as a one-shot internal agent (`runSideHelperModel`): `internal: true`, no persisted session, an empty folder under the OS temp dir as its cwd, the provider's safe mode (`colorTier: "safe"`, OMP `ask`), and closed and deleted once the answer is in. It is created with `CreateAgentOptions.toolless`, which the OMP provider turns into `--no-tools --no-skills --no-rules --no-context-files --no-extensions --no-lsp --no-title --system-prompt=<SIDE_HELPER_SYSTEM_PROMPT>` and no Paseo tools or MCP servers. `--no-tools` also turns off OMP's own MCP. So the model has no tools at all, read tools included, and sees only our system prompt and the chat data sent inline.

A provider that does not implement `toolless` ignores it. For that case every `permission_requested` is still denied (the same guard `ask_agent` copies use).

The model never acts. It replies with one JSON object (`parseHelperReply` in `voice-helper-actions.ts`): an answer, or one of four proposals that name a chat (`[c3]`) or project (`[p2]`) by the refs the chat data carries, plus the owner's own words for it (`target`). The daemon does the rest. Keep it that way: a model that calls Paseo tools itself would skip the read-back.

## Actions

- **Which chat.** `resolveChat` prefers the owner's words over the model's ref, through the same matcher "go to" uses (`resolveGoToTarget`), then any chat title on the host. A project with several chats takes the ref only when it points inside that project, else asks "Which X chat?". A ref alone covers "the chat waiting on me". Refs are positions in `buildVoiceChatDirectory` order, built fresh for each question, so a ref from an older question is never reused. Only this daemon's chats are offered; chats on connected hosts are not.
- **Confirmation has no model call.** `classifyConfirmation` covers the whole reply with fixed English and Vietnamese phrases plus filler, longest phrase first. Vietnamese marks are kept: stripped, "đúng" (yes) and "đừng" (don't) are both "dung". The action's own verb counts as yes for that action only ("stop it" confirms a stop, "don't send it" refuses). More than 8 words is unclear, so "yes, and also add tests" is never a yes.
- **While a step waits**, every utterance goes to it and nothing reaches a chat. A new "Paseo, ..." replaces it, but "Paseo, yes" still answers it. Voice off, moving voice, and a new question clear it. The short-word VAD window stays on (`refreshSpeechConfirm`) so a bare "yes" ends the turn.
- **Quiet** is timed from the end of the read-back's playback, not from when it was queued: Kokoro took several seconds to synthesize a read-back on CPU. A reply still being spoken when the 8 s run out gets 1 s more, up to 30 s in all.
- **Send** uses the steer active-turn behavior, like spoken input, so it joins a run instead of replacing it.
- **Answer** goes through `respondToAgentPermission`. A question box takes one question only, matched by `interpretSpokenAnswer` (the same matcher as spoken question answers), and is sent as `updatedInput.answers[header]`. A permission picks the primary allow or deny button, as a tap would; the read-back names the shell command when there is one, so a yes never approves a command the owner didn't hear.
- **Start** copies provider, model, mode and thinking option from the project's newest chat. A project with no chat uses its workspace and the newest chat anywhere on the host.
- **Stop** goes through `cancelAgentRunCommand`, the app's stop path, and is offered only for a chat that is `running`.
- Every run logs `Voice helper action` with the action, the chat or project id and the text length, never the text.

## Cost and time

- Context cap: `SIDE_HELPER_CONTEXT_TOKENS` = 6000 tokens, estimated at 4 characters each. Timelines get 60%: the current chat plus up to two chats the question names, last 12 items each, 600 characters per entry, newest kept. The chat list gets the rest, current chat and chats waiting on you first, then a "and N more" line.
- Toolless, the prompt is about the system prompt plus the chat data. Before `toolless` each question carried about 22.9k cached input tokens of OMP's coding prompt, tool schemas and context files. The daemon log line `Voice helper call` has the real `inputTokens`, `cachedInputTokens`, `outputTokens`, `costUsd` and `durationMs` for each question. OMP reports usage after the turn, so the line comes up to 2 s after the answer.
- "One sec." after 1.5 s, "Sorry, no answer." after 20 s or on any failure. Voice off, abort, or the next question cancels the run silently. "One sec." is synthesized once per TTS provider and kept in memory (`TTSManager.prepareSpeechClip`), made when voice turns on and again when a question starts (it is re-made when the read-back speed changed; see `docs/voice-readback.md`), because Kokoro took about 4 s to synthesize it on demand and the cue came long after its timer.
- The model is `features.voiceMode.sideHelperModel` (`<provider>/<model>`), read at every question. The default `omp/anthropic/claude-haiku-5-5` is provisional.

## Checking it again

Needs a built daemon (`npm run build:server`), the local speech models, and OMP logged in on the host. Start the isolated daemon as in [voice-send.md](voice-send.md#checking-it-again), with `agents.providers.omp.enabled: true` and `daemon.mcp.injectIntoAgents: true` in its config.

1. Create `mock` agents in two or three folders and title them (`updateAgent(id, { name })`). Give one a timeline with a known fact (send it a message; the mock replies). "Emit synthetic plan approval" leaves a chat with a pending permission; a chat on model `thirty-minute-stream` stays `running` long enough to stop (`one-minute-stream` often ends before you get to it).
2. Turn voice on in one chat and stream mic audio with Kokoro clips spliced in, as in voice-navigate.md. Ask "Paseo, which chats are waiting on me?", "Paseo, what's going on in <project>?" and "Paseo, what did the agent just say?".
3. Expect each answer as an `activity_log` `assistant` event with the right facts, no `user_message` in the chat voice is in, and a `Voice helper call` line per question in `$PASEO_HOME/daemon.log`. Then say a plain sentence; it beeps and reaches the chat.
4. For actions, say "Paseo, tell <chat> to ...", "Paseo, approve the plan in <chat>", "Paseo, stop <chat>" and "Paseo, start a new chat in <project> and ask it to ...". Expect the read-back, nothing changed until you say "Yeah, go ahead" (or "Sure", "Do it"), then "Sent." / "Approved." / "Stopped." / "Started." and the change in the timeline or agent list, with a `Voice helper action` line. "No, wait." gives "Okay, not doing it."; a mumble gets "Should I send it? Say yes or no." once, then the drop.
5. In the web app at 390x844 (Metro with `EXPO_PUBLIC_LOCAL_DAEMON` set to the isolated daemon, whose `daemon.cors.allowedOrigins` must list the Metro origin, or the socket gets a 403), **Settings > Voice** shows the **Answers "Paseo, …"** row with Haiku 5.5 and Sonnet 5.5; tapping one writes `features.voiceMode.sideHelperModel` to the host's `config.json`. A sent message shows in the target chat like a typed one.

Keep live runs short: each question is one paid model call. The yes and no are free.
