# Notes

A note is text the owner attaches to a selection in a chat or a terminal. A waiting-on note also names an event; when it happens, the host notifies the owner and resolves the note.

## Where notes live

Notes live on the daemon that owns the chat or terminal, in `$PASEO_HOME/notes.json` ([data-model.md](data-model.md#6a-notes)). A note made on a remote host's agent is stored on that host, and that host watches its event. The app never keeps its own copy beyond the last list it received.

Each note stores a copy of the selected text (`quote`) next to its `anchor`. The anchor is only good enough to jump back: chat offsets are positions in the rendered text of one message fragment, and terminal lines shift as scrollback is trimmed. Views locate a note by its anchor first and fall back to searching for the quote.

## Events

| Wait               | Fires when                                                                                      | Source                                                                 |
| ------------------ | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `agent`            | The agent finishes, errors, or asks for permission/input                                        | `AgentManager` attention callback                                      |
| `terminal-command` | The next command to finish in that terminal; `condition` picks any, success (exit 0) or failure | OSC 633 `D;<exit>` from Paseo's shell integration                      |
| `time`             | The daemon's clock reaches `at`                                                                 | One `setTimeout` for the earliest armed time, re-armed on every change |

A waiting-on note fires once. A command that finishes without meeting the condition still ends the wait: the note records the result (`waitResult.matched: false`) and stays open, because it was bound to that command.

Command events need Paseo's shell integration, which exists for zsh (`ZDOTDIR` wrapper) and bash (`--rcfile` wrapper that sources `~/.bashrc` first). Both live in `packages/server/src/terminal/shell-integration/`. bash skips its hooks when another DEBUG trap is already installed (bash-preexec, atuin), so those shells get no command events. Other shells get none either. The user's dotfiles are never edited.

## Notifications and the one-alert rule

The daemon delivers a fired note like agent attention: `computeNotificationPlan` picks one present client for an in-app notification, otherwise it sends an Expo push. The push data carries `noteId` plus the agent or terminal ids, so a tap opens the note's spot ([notifications.md](notifications.md)).

A phone that creates a time note also schedules a local notification, so the reminder still arrives when the host is asleep. It records the claim in `localReminder: { deviceId, at }`. While a claim matches the wait's time, the daemon resolves the note at that time without pushing. Moving the time from another device clears the claim, so the daemon pushes again and the phone cancels its local notification when it sees the change.

## Clients

Clients subscribe to `notes.list.request` with `subscribe`, only while a screen shows that host's notes (`useNotesDemand` in `packages/app/src/notes/store.ts`). Changes arrive as `notes.changed`; there is no polling. Hosts without `server_info.features.notes` show no notes UI.

## Where you can add a note

| Surface                              | Entry point                                                                                                                                                                               | Highlight and jump                                                                                               |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Web chat (desktop and phone browser) | "Add note" pill at the selection, below it on touch so it clears the browser's own menu                                                                                                   | CSS Custom Highlight API; jump scrolls and flashes, using chat find's host search when the message is not loaded |
| Native chat                          | Assistant text: selection menu item via the Markdown library's `contextMenuItems`. User messages and finished turns: a message-level button, because RN `Text` takes no custom menu items | None; the native list cannot scroll to a message, so opening the chat is the whole jump                          |
| Web terminal                         | Browser: pill at the selection. Electron: terminal context menu item                                                                                                                      | xterm decorations; jump scrolls and selects                                                                      |
| Native terminal                      | "Add note" next to the floating Copy                                                                                                                                                      | None; jump scrolls and selects                                                                                   |

Native Markdown selection offsets count within one rendered fragment, not the message, so native chat notes store the quote and row without offsets. A note made on native is found on web by its quote.
