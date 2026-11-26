# Sidebar project strip

The project strip switches the sidebar between projects. Desktop shows it as an icon rail on the sidebar's left edge; compact layouts show it as a chip row under the sidebar's top buttons. The first entry, All, shows every project. Code: `packages/app/src/components/sidebar/project-strip.tsx`, rules in `project-strip-model.ts`.

## It reuses sidebar state

The strip owns no store.

- **Selection is the project filter.** Picking a project calls `showOnlyProject`, which sets `projectFilters` to that one key; All clears it. The display menu's Project filter and the strip are two views of one value, so a filter picked in either shows in both. A multi-project filter from the menu marks each of its projects selected in the strip.
- **Order is the sidebar's project order.** `useSidebarOrderStore.projectOrder` orders the strip and the project groups in the list. Moving a project in one moves it in the other. Saves go through `mergeWithRemainder`, so projects a host filter hides keep their place.
- **Projects are the ones the list can show.** The strip skips a project whose every workspace the display filters hide (background workspaces while Show background is off, a label filter), so a chip never opens an empty list. The project filter does not narrow the strip: it is the strip's own selection.
- **Numbers are strip positions.** The first nine projects get Cmd/Ctrl+1-9 (Alt+1-9 on web), published through `sidebarShortcutProjects` by `WorkspaceShortcutTargetsSubscriber`. See [keyboard-shortcuts.md](keyboard-shortcuts.md#digit-groups) for how the three digit groups split the modifiers.

## Layout rules

- The strip shows only with two or more projects. With one there is nothing to switch, and the digit keys publish no project targets.
- The desktop rail sits inside the sidebar's width (52 px), below the window chrome row, so the titlebar drag region and the resize handle keep their places.
- Desktop reorders by dragging an icon (`DraggableList` with a drag handle). Compact reorders from each chip's menu (long-press on a phone, right-click on web): Move to first, Move earlier, Move later. A sideways drag on the chip row scrolls it, and on native the row blocks the sidebar's swipe-to-close pan for the whole drag, also after the finger slides off the row or the row hits its end (see [mobile-panels.md](mobile-panels.md#integration-rules)).

## The phone's top buttons

On compact layouts the header sidebar items sit in one row of round icon buttons, with the close button at the right (`SidebarNavIconRow` in `components/sidebar/sidebar-nav-rows.tsx`). The row provides `SidebarNavIconRowContext`; `SidebarHeaderRow` with the `compact` variant reads it and draws `SidebarNavIconButton` instead of a full row. Built-in rows, plugin kit `SidebarRow`s and legacy plugin rows all render through `SidebarHeaderRow`, so a plugin item becomes an icon with no change on its side, and the kit's `SidebarSeparator` renders nothing there.

- A tap does what the row did. A long press opens the button's menu as a sheet titled with its name; its one row, Buttons to show, opens a page that ticks each button on or off. On web, where `ContextMenuTrigger` opens only on right-click, the button also opens the menu on long press so a phone browser gets it. That sheet mounts under the finger, and when the finger lifts the browser sends its compatibility mousedown and click to the sheet's backdrop, which closes it at once; `swallowTouchRelease` (`components/sidebar/swallow-touch-release.web.ts`) cancels that touch's `touchend` so the click never comes. Reuse it for any other web long press that opens an overlay.
- The ticks write the same per-device `sidebarNavItems` preference as Settings > Sidebar, so Settings stays the way back. The last visible button cannot be unticked.
- Defaults differ by layout: `COMPACT_HIDDEN_BY_DEFAULT` in `sidebar-nav/model.ts` lists the keys that start hidden on compact (Notes). A stored choice always wins, and any edit stores the whole list, so a phone edit keeps Notes hidden on that device until it is ticked on.
- Trailing content (shortcut hints, a plugin row's `trailing`) is dropped in the icon row; there is no room for it.
- The compact workspace list is lighter too: an empty project has no "+ New workspace" ghost row, since the project row's + and the New workspace button already create one, and chat rows have no copy-agent-ID icon; Copy agent ID stays in the row's ⋮ menu.
- To check it again: `npx playwright test --project=browser e2e/browser/sidebar-phone-icons.spec.ts` from `packages/app` taps through all of the above at 390×844 with touch, plus the desktop sidebar at 1280, and writes `.scratch/phone-icons-*.png`.

## Last chat

Each project remembers the workspace you last had open in it (`useSidebarLastChatStore`, per device). `WorkspaceShortcutTargetsSubscriber` records it: whenever the open workspace or the project list changes, it finds the open workspace's project and stores the pair. It reads the project list on every change because a workspace opened before its host's directory loaded has no project yet.

- **Desktop:** the project jump and a rail click show the project and reopen that workspace. On the desktop layout the chat sits beside the list, so going back to where you were is one step.
- **Compact:** the jump and a chip tap only change the list. The remembered workspace gets a "last open" tag, one tap away. The tag shows only while the strip shows that one project, and not on the row that is already open.
- A remembered workspace the project no longer lists (archived, moved) is ignored at jump time (`resolveProjectLastChat`), not deleted: a host that has not loaded yet lists nothing, and deleting then would forget every chat on it.
- No remembered workspace: the jump only changes the list. It does not guess one.

## The waiting badge

Each project shows how many of its workspaces have the `needs_input` status, through `countProjectWorkspacesNeedingInput`. It counts every workspace in the project, including collapsed and hidden ones, because the strip is how you find work in a project you are not looking at.

The badge is the palette purple (`theme.colors.palette.purple[500]`), the same purple as the New main agent dot, not the orange `needs_input` status dot. The status dots on workspace rows keep the orange; only the strip badge is purple, so a project-level count reads apart from a single workspace's status.

## Jump keys

Two keys move between workspaces across projects, whatever the strip shows. Their combos are in [the binding table](keyboard-shortcuts.md#jump-keys).

- **Recent walk.** `useRecentWorkspacesStore` (per device) keeps the workspaces you opened, newest first; `WorkspaceShortcutTargetsSubscriber` records each one. The first Tab highlights the workspace you had open before this one, each further Tab goes one older, and Shift goes one newer. On web, `RecentWorkspacesOverlay` lists the walk while the modifier is held and releasing it opens the highlighted workspace. Native has no held walk: each press opens its step at once, so repeated presses flip between the last two workspaces, because hardware keyup there is not reliable enough to end a walk on. Blur ends a walk without opening anything. Entries the sidebar does not list sit out the walk and stay in the list, for the same reason as a stale last chat.
- **Next waiting.** `resolveWaitingWorkspaces` lists every `needs_input` workspace from the unfiltered entries (`allWorkspaceEntriesByKey`), the longest wait first, so a filter never hides one. The key opens the one after the open workspace and wraps. The phone has no key, so the compact sidebar shows a Next waiting button with the count, only while some other workspace is waiting.

## Quiet projects

A project with no chat activity for 3 days folds into "More": on the rail, on the chip row, and at the end of the project list. Any new activity brings it back.

- **Activity** is the newest of a workspace's creation, last prompt, status change, and its root agent's last status change, across the project (`deriveProjectActivity`). A project with nothing known stays out: unknown is not quiet.
- **Never folds:** a project with a workspace waiting on you, the project of the open workspace, a project with a pinned workspace, and a project the filter picked. When every project would fold, none does.
- **Time** is read hourly (`useQuietProjectKeys`), so a project folds within an hour of crossing 3 days.
- **One toggle.** "More" opens on the rail, the chips and the list together (`useSidebarQuietFoldStore`, not persisted, so quiet projects start folded each launch). Opened projects list after the ones that show and don't drag on the rail. Opening it on the chip row scrolls the row so "More" sits at its left edge with the opened chips after it; without that they land past the right edge.
- **One count.** The strip and the list fold from the same projects (`displayProjects` in `sidebar-model.tsx`), so the chip and the list's "More" row show the same number.
- **Digits** count the projects that show first, then the quiet ones, matching the rail.
- The list folds only in project grouping with no project filter. Status grouping has no project rows to fold.

## Adding to the strip

Later sidebar features plug in here rather than adding a second switcher:

- Per-project actions on the chip menu go in `ProjectChip`'s `ContextMenuContent`. The desktop rail has no menu yet; give it one with the same items before adding desktop-only actions.
- Anything that changes what selecting a project does belongs in the callers of `showOnlyProject`: the rail and chip press handlers and the `show-sidebar-project` keyboard route in `use-shortcuts.ts`.
- Badges other than the waiting count go beside `NeedsInputBadge`, fed by a hook like `useSidebarProjectNeedsInputCount` that reads the session store with a primitive selector.
