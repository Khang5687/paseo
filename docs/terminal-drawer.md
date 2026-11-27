# Terminal drawer

Each chat has its own terminal drawer: a panel of shells that belongs to that chat, started in the chat's folder. Desktop docks it under the chat; a phone shows it as a bottom sheet. It follows VS Code's panel: toggling hides the panel but keeps the shell alive, and the panel closes when its last shell exits.

Code: `packages/app/src/terminal-drawer/`. Pure rules (tab order, snaps, the toggle) live in `model.ts` with tests in `model.test.ts`.

## Ownership lives on the host

A drawer terminal is an ordinary workspace terminal with `ownerAgentId` set to the chat. The host keeps the owner in the terminal worker's state, so it survives a daemon restart and ends with the shell. Every client sees the same drawers; the device only keeps view state (open, height, maximized, active tab, phone snap) in the persisted `terminal-drawer` store.

- `create_terminal_request` takes `ownerAgentId`. Terminal lists report it.
- `terminal.owner.set` moves a terminal between a drawer and a workspace tab. Pop-out sets the owner to `null` and opens the tab.
- Archiving a chat closes its drawer terminals.
- Workspace terminal tabs skip owned terminals (`screens/workspace/terminals/state.ts`). A drawer terminal never gets a workspace tab until it is popped out.

Gate on `server_info.features.chatTerminals`. Against an older host the header toggle is hidden and `` Ctrl+` `` does nothing, since an owner the host drops would turn every drawer terminal into a workspace tab.

`toTerminalListEntry` (`utils/terminal-list.ts`) must copy `ownerAgentId` and `createdAt`. When it dropped them, a terminal created from the drawer showed up as a workspace tab until the next list refresh.

## Focus

The drawer takes focus only when asked: opening it, adding a terminal, or tapping it. A drawer that takes focus whenever it renders steals typing from the composer on every chat switch. `` Ctrl+` `` also fires inside a focused terminal, so the same key hides the drawer and hands focus back to the composer. See [keyboard-shortcuts.md](keyboard-shortcuts.md#focus-scopes) for why the key is `` Ctrl+` `` on every platform.

## Phone sheet

The sheet has four snaps: `bar` (one line, the active terminal's last printed line), `half` (chat visible above), `full`, and `chat` (sheet hidden, a floating Terminal button brings `full` back). Only one of the Chat and Terminal buttons shows at a time. Drag the grabber between snaps; `settlePhoneDrawerDrag` picks the nearest snap or follows a flick.

Swipe sideways in the terminal to switch tabs. The swipe goes through `TerminalPane`'s `onSwipe`, which replaces the pane's own swipe that opens the sidebar or the explorer. Do not add a gesture around the pane for it: the terminal emulator detects its own swipes, so an outer pan fires alongside them and the panel opens too.

Phone web (`hasTouch` with `deviceScaleFactor: 2` in Chrome device emulation) paints a blank terminal. Test phone width at scale factor 1. A swipe that starts in the chat area can trigger Chrome's history navigation in emulation; start drawer swipes inside the terminal.

## Check it again

1. Start a dev daemon and Metro against it (see [development.md](development.md)). Create a chat with the `mock` provider.
2. Desktop: press `` Ctrl+` `` in the composer. The drawer opens in the chat's folder with the terminal focused. Type `echo alive`, press `` Ctrl+` `` twice: the same shell shows `alive`. Add a tab with +, drag the top edge, maximize, pop out (a workspace tab opens with the same shell), kill the last tab (the drawer closes).
3. Phone width 390×844: tap the terminal icon in the header. Drag the grabber up for full screen, tap Chat, tap Terminal, drag down to the bar and check its last line. With two tabs, swipe left and right in the terminal.
4. `paseo daemon stop --keep-terminals`, start the daemon again: the drawer still holds its terminals, and a popped-out terminal is still a tab.
