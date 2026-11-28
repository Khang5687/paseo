# Voice navigate

How a spoken "go to fitup", "list chats" or "go back" moves Voice mode to another chat, on this host or another one the app is connected to, with no model involved. User-facing behavior is in `public-docs/voice.md`. This doc holds what the code can't tell you.

## Shape

- The daemon reads the command; the app does the move. `VoiceSession.handleNavigation` (`packages/server/src/server/session/voice/voice-session.ts`) parses the transcript, resolves the name and sends `voice.navigate` with the chat's `agentId` and `workspaceId`, plus `serverId` and `speech` when the chat is on another host. The app's session context calls `navigateToAgent` and then `voiceRuntime.startVoice` for that host and chat.
- Both sides are gated. The host advertises `server_info.features.voiceNavigate`; the app then sends `navigation: true` in `set_voice_mode`. Without that flag the daemon never reads speech as a command, so an old app talking to a new host sends "go to fitup" to the agent as before. Other hosts need a second gate, `voiceNavigateHosts`, and `navigationHosts: true`; without it the host only goes to its own chats.
- Commands are matched on the whole utterance, before the send gate: no beep, no hold, no "over" needed (a trailing "over" is stripped). A held message is settled first, so words after a beep still send it.
- "Go to X" is a command only when X names a project or chat on some host. "Go to the auth module and add logging" parses as a go-to, names nothing, and goes to the agent. This is what keeps everyday talk that starts with "go to" safe.
- The host's own names come from `VoiceSessionHost.listVoiceChats`, built by `buildVoiceChatDirectory` (`packages/protocol/src/voice/chat-directory.ts`). A chat is a top-level agent (no parent label), not archived, not internal, not background, in an active workspace of a project that is not archived. Chats are newest first by last user message.
- "Paseo, go to fitup" is the same command: the side helper strips the name and hands exact commands to navigation first. Everything else after "Paseo," is a question for the side helper; see [voice-side-helper.md](voice-side-helper.md).

## Matching

The matcher lives in `packages/protocol/src/voice/chat-match.ts` so the daemon (its own chats) and the app (every other host's chats) score a name the same way. `spokenNameScore` compares letters by edit distance with spaces removed, because STT writes "Fit Up" for fitup, "hands free" for hands-free, and "Paceo" for paseo. A run of words inside a long title ("food scan" in "Food scan redesign") scores 0.95 of a whole-name match, so "paseo" picks the project `paseo` over `paseo-sync`. The bar is 0.8. `scoreGoToTarget` tries every split of the words into project words and chat words, and also a chat of the current project alone. On a tie a project beats a project with a chat, which beats a chat of the current project.

## Other hosts

The daemon with voice cannot see other hosts; the app can. On every go-to the daemon sends `voice.navigate.find_chats.request` with the spoken name, and the app answers from its own copy of each other host (`packages/app/src/voice/voice-host-chats.ts`) with the best match per host. The daemon merges that with its own match in `pickHostMatch`:

- An online host's match beats any offline one. Online matches within 0.01 of each other are the same name on two machines: voice asks "FitUp on Omen or on Mac?" and the next words pick the host by name or "the second one".
- When only an offline host has the name, voice says "Groceries is on Mac, which is offline." and stays. The app keeps a host's last known chats while it is offline, which is how it can still answer.
- The daemon asks on every go-to, not only when nothing matches here, because a duplicate name has to be a question and a better name elsewhere has to win. One app round trip per go-to; after 3 s with no answer the daemon goes on with its own chats.

Only the matched project (with its chats, for "which one?") reaches the asking daemon. A host shared with someone else never receives your other hosts' chat lists.

Host names are the app's labels for the hosts, and the asking host's own label comes back in the answer, so the daemon can say "on Omen" without knowing what the app calls it.

## The new voice session

The app turns voice off on the old chat and on for the new one, and the daemon releases a voice session once it has no demand. So the move ends one `VoiceSession` and starts another on the same socket. Anything that must survive the move lives in `VoiceNavMemory`, which `VoiceSessions` keeps per socket: the chat voice was on (for "go back") and the arrival speech. The arrival speech ("fitup, Main chat.": project name, then chat title) is queued when `set_voice_mode` turns voice on in the named chat, so it only plays once voice is really there.

A move to another host lands on a different daemon, which has no memory of where voice came from. The app carries it: `set_voice_mode.arrival` holds the speech the old host built ("FitUp on Mac, Gym log.") and `previous` (that host and chat). The new host says the speech and keeps `previous`, so "go back" asks the app for that one chat (a `chat` query) and moves back across hosts. The app sends `previous` on every host change, a tap included, so "go back" works after a manual move too.

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

Across hosts, check in the web app, since the app answers the lookups:

1. Start two isolated daemons on two ports (say 6781 and 6782), each with its own `PASEO_HOME`, `PASEO_CORS_ORIGINS=http://localhost:<metro port>`, and `mcp.injectIntoAgents` on (voice mode refuses to start without Paseo tools). Give the first `fitup` (two chats) and `paseo`, the second `fitup` (one chat) and `groceries`.
2. Start Metro with `EXPO_PUBLIC_LOCAL_DAEMON=localhost:6781`. At 390×844, tap the hosts button in the sidebar footer, add the second host as a direct connection, and rename the hosts "Omen" and "Mac" in Settings → Hosts.
3. Launch Chromium with `--use-fake-device-for-media-stream --use-file-for-fake-audio-capture=<wav>`, where the wav holds the commands below with 12 to 26 s of silence between them. Open Omen's paseo chat and tap Enable Voice mode.
4. Expect: "Go to groceries, shopping list." opens the Mac chat and Mac says "groceries on Mac, Shopping list."; "Go back." returns to Omen; "Go to fitup." asks "fitup on Omen or on Mac?" and stays; "On the Mac." opens Gym log on Mac; stop the Mac daemon, then "Go to groceries." gets "groceries is on Mac, which is offline." on Omen. The page URL changes host with each move; each daemon's `daemon.log` holds the transcripts (`Transcription result`) and the speech (`TTS input text`).
