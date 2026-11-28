# Voice navigate

How a spoken "go to fitup", "list chats" or "go back" moves Voice mode to another chat with no model involved. User-facing behavior is in `public-docs/voice.md`. This doc holds what the code can't tell you.

## Shape

- The daemon reads the command; the app does the move. `VoiceSession.handleNavigation` (`packages/server/src/server/session/voice/voice-session.ts`) parses the transcript, resolves the name and sends `voice.navigate` with the chat's `agentId` and `workspaceId`. The app's session context calls `navigateToAgent` and then `voiceRuntime.startVoice` for that chat.
- Both sides are gated. The host advertises `server_info.features.voiceNavigate`; the app then sends `navigation: true` in `set_voice_mode`. Without that flag the daemon never reads speech as a command, so an old app talking to a new host sends "go to fitup" to the agent as before.
- Commands are matched on the whole utterance, before the send gate: no beep, no hold, no "over" needed (a trailing "over" is stripped). A held message is settled first, so words after a beep still send it.
- "Go to X" is a command only when X names a project or chat. "Go to the auth module and add logging" parses as a go-to, names nothing, and goes to the agent. This is what keeps everyday talk that starts with "go to" safe.
- Names come from one host function, `VoiceSessionHost.listVoiceChats` (built by `buildVoiceChatDirectory` in `voice-chat-directory.ts`). The parser and matcher in `voice-navigate.ts` only see the `VoiceChatProject[]` it returns. Today it lists the daemon's own projects; a lookup across hosts would replace that one function.
- A chat is a top-level agent (no parent label), not archived, not internal, not background, in an active workspace of a project that is not archived. Chats are newest first by last user message.

## Matching

`spokenNameScore` compares letters by edit distance with spaces removed, because STT writes "Fit Up" for fitup, "hands free" for hands-free, and "Paceo" for paseo. A run of words inside a long title ("food scan" in "Food scan redesign") scores 0.95 of a whole-name match, so "paseo" picks the project `paseo` over `paseo-sync`. The bar is 0.8. `resolveGoToTarget` tries every split of the words into project words and chat words, and also a chat of the current project alone. On a tie a project beats a project with a chat, which beats a chat of the current project.

## The new voice session

The app turns voice off on the old chat and on for the new one, and the daemon releases a voice session once it has no demand. So the move ends one `VoiceSession` and starts another on the same socket. Anything that must survive the move lives in `VoiceNavMemory`, which `VoiceSessions` keeps per socket: the chat voice was on (for "go back") and the arrival speech. The arrival speech ("fitup, Main chat.": project name, then chat title) is queued when `set_voice_mode` turns voice on in the named chat, so it only plays once voice is really there.

Words still waiting for "over" are dropped by the move, the same as turning voice off.

## Short words

"Go back" (about 0.6 s of speech) is shorter than the VAD's default 800 ms confirm window and is never heard at it. With navigation on, the window is 300 ms whenever no speech is playing; the rule and its reasons are in [voice-send.md](voice-send.md#short-words-and-the-vad). In silence, noise can now open turns that STT finds empty; they are dropped, and the pre-roll keeps them out of the next message.

## Checking it again

Needs a built daemon (`npm run build:server`), the local speech models, and a free port. Start the isolated daemon as in [voice-send.md](voice-send.md#checking-it-again), with a fresh `PASEO_HOME` per run (each run adds chats).

1. Create `mock` agents in a few folders; each folder is a project, and `updateAgent(id, { name })` sets the chat title. Use two projects with two chats each and one project whose name starts like another (`paseo` and `paseo-sync`).
2. Play the app: `setVoiceMode(true, agentId, { navigation: true })`. On `voice.navigate`, call `setVoiceMode(false)` and then `setVoiceMode(true, payload.agentId, { navigation: true })`, as `voiceRuntime.startVoice` does.
3. Stream mic audio and splice in spoken clips as in voice-send.md. Wait for a chat list to finish playing before you answer it.
4. Expect: "Go to fitup food scan." moves with no beep and says "fitup, Food scan redesign."; "Go back." returns; "Go to paseo." reads the names newest first and asks, then "The second one." or a name moves; "Tell me a joke." after the list gets "No chat called that." and sends nothing; "Go to the auth module and add logging." beeps and reaches the agent; in over mode "Go to fitup main chat, over." moves at once; without `navigation` every command reaches the agent.
5. Noise: feed `ffmpeg -f lavfi -i anoisesrc=color=brown:amplitude=0.25:sample_rate=24000` (and pink) through the mic for minutes with navigation on. Expect no message and no beep; count the empty `transcription_result` events. A message spoken over quieter noise must arrive alone, and "Yes." in silence must still reach the agent.

In the web app, the screen must follow: with voice on in one chat, a `voice.navigate` opens the other chat and its composer shows voice on.
