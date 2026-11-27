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
- Desktop reorders by dragging an icon (`DraggableList` with a drag handle). Compact reorders from each chip's menu (long-press on a phone, right-click on web): Move to top, Move earlier, Move later, Move to bottom, and Reorder projects…. A sideways drag on the chip row scrolls it, and on native the row blocks the sidebar's swipe-to-close pan for the whole drag, also after the finger slides off the row or the row hits its end (see [mobile-panels.md](mobile-panels.md#integration-rules)).

## Reordering

Every way of moving a project writes the one order the strip and the list share (`saveProjectStripOrder` in `components/sidebar/project-order.ts`), so a move anywhere shows everywhere.

- **The ⋯ menu.** A project row's ⋯ menu (and its right-click menu) carries Move to top, Move to bottom and Reorder projects… on every platform (`useProjectOrderMenuActions`). With one project it carries none of them.
- **Reorder projects…** opens the rail wide on the desktop, where you drag (see below). A phone has no rail, so there it opens the Reorder projects sheet (`ReorderProjectsSheet`): every project in one list, held and dragged into place. The whole row is the handle; a quick swipe still scrolls the sheet ([drag-reorder.md](drag-reorder.md)). The sheet mounts with the chip row, which shows whenever there is anything to order.

## The open rail

The rail's first button (» at the top) opens it wide over the sidebar: each project gets its icon, name and a grip. « Collapse, now the first row, closes it. The open state is per device and survives a restart (`useSidebarRailOpenStore`); nothing else closes it, so it stays open while you drag and after you pick a project.

- **It lies over the sidebar, it does not push it.** The rail becomes `position: absolute` inside `SidebarProjectRailLayout`, and a 52 px spacer takes its place, so the workspace list keeps its width and does not reflow on every toggle.
- **Same list, same drag.** Open and closed render the one `DraggableList`; only the row shape changes. Tooltips show only while closed, since the open rail writes the names out.
- **The rail's menu.** Right-click on a rail icon opens Move to top, Move to bottom (`listProjectEndMoves`) and, while closed, Reorder projects…, which opens the rail to drag there. The desktop has drag for fine moves, so the menu carries only the two long jumps. `ContextMenuTrigger contextOnly` keeps the left click for selecting and dnd-kit's mouse sensor ignores the right button, so the menu and the drag never fight.
- A toggle that changes size under a still pointer gets no `pointerleave`, so `RailOpenToggle` remounts its button per state to drop the old hover.

## The phone's top buttons

On compact layouts the header sidebar items sit in one row of round icon buttons, with the close button at the right (`SidebarNavIconRow` in `components/sidebar/sidebar-nav-rows.tsx`). The row provides `SidebarNavIconRowContext`; `SidebarHeaderRow` with the `compact` variant reads it and draws `SidebarNavIconButton` instead of a full row. Built-in rows, plugin kit `SidebarRow`s and legacy plugin rows all render through `SidebarHeaderRow`, so a plugin item becomes an icon with no change on its side, and the kit's `SidebarSeparator` renders nothing there.

- A tap does what the row did. A long press opens the button's menu as a sheet titled with its name; its one row, Buttons to show, opens a page that ticks each button on or off. On web, where `ContextMenuTrigger` opens only on right-click, the button also opens the menu on long press so a phone browser gets it. That sheet mounts under the finger, and when the finger lifts the browser sends its compatibility mousedown and click to the sheet's backdrop, which closes it at once; `swallowTouchRelease` (`components/sidebar/swallow-touch-release.web.ts`) cancels that touch's `touchend` so the click never comes. Reuse it for any other web long press that opens an overlay.
- The ticks write the same per-device `sidebarNavItems` preference as Settings > Sidebar, so Settings stays the way back. The last visible button cannot be unticked.
- Defaults differ by layout: `COMPACT_HIDDEN_BY_DEFAULT` in `sidebar-nav/model.ts` lists the keys that start hidden on compact (Notes). A stored choice always wins, and any edit stores the whole list, so a phone edit keeps Notes hidden on that device until it is ticked on.
- Trailing content (shortcut hints, a plugin row's `trailing`) is dropped in the icon row; there is no room for it. A plugin row's `badge` is not: `SidebarNavIconButton` draws it on the button's corner (`SidebarBadge` in `components/sidebar/sidebar-badge.tsx`), so a count like "2 tasks late" survives on the phone.
- The compact workspace list is lighter too: an empty project has no "+ New workspace" ghost row, since the project row's + and the New workspace button already create one, and chat rows have no copy-agent-ID icon; Copy agent ID stays in the row's ⋮ menu.
- To check it again: `npx playwright test --project=browser e2e/browser/sidebar-phone-icons.spec.ts` from `packages/app` taps through all of the above at 390×844 with touch, plus the desktop sidebar at 1280, and writes `.scratch/phone-icons-*.png`.

## Last chat

Each project remembers the workspace you last had open in it (`useSidebarLastChatStore`, per device). `WorkspaceShortcutTargetsSubscriber` records it: whenever the open workspace or the project list changes, it finds the open workspace's project and stores the pair. It reads the project list on every change because a workspace opened before its host's directory loaded has no project yet.

- **Desktop:** the project jump and a rail click show the project and reopen that workspace. On the desktop layout the chat sits beside the list, so going back to where you were is one step.
- **Compact:** the jump and a chip tap only change the list. The remembered workspace gets a "last open" tag, one tap away. The tag shows only while the strip shows that one project, and not on the row that is already open.
- A remembered workspace the project no longer lists (archived, moved) is ignored at jump time (`resolveProjectLastChat`), not deleted: a host that has not loaded yet lists nothing, and deleting then would forget every chat on it.
- No remembered workspace: the jump only changes the list. It does not guess one.

## Status dots

Each project shows one small dot per chat that has something going on: purple asks you, red failed, green finished and not opened yet, blue blinks while working (`ProjectStatusDots` in `components/sidebar/project-status-dots.tsx`). Done chats you already opened get none. The rail stacks the dots down the icon's right edge; a chip lines them up after its name. The counts come from `countProjectWorkspaceStatuses`, across every workspace in the project, including collapsed and hidden ones, because the strip is how you find work in a project you are not looking at.

- **Four places, urgent first.** `listProjectStatusDots` orders asking, failed, done, working. Past four, the last place becomes a "+", so working chats lose their dot first and the ones that want you stay visible.
- **No numbers on the icon.** Exact counts are in the closed rail's tooltip and accessibility label ("Asking you: 1, Working: 2", `useProjectStatusLabel`) and beside the name on the open rail (`ProjectStatusCountList`). A chip has no hover, so its counts are in its accessibility label only; the list under it shows every chat.
- **Purple, not orange.** Asking is the palette purple (`theme.colors.palette.purple[500]`), the same purple as the New main agent dot. Workspace rows keep the orange `needs_input` dot, so a project-level mark reads apart from one chat's status. The other three reuse the row dot colors.
- The blink is a Reanimated opacity loop on an `Animated.View` that carries no Unistyles style (see [unistyles.md](unistyles.md)); it holds still under reduced motion.

A collapsed project row in the list has its own aggregate: the most urgent status as a corner badge (`deriveProjectStatus`). When it is working only on chats that wait on a background job, the badge is the hourglass, not the ring, the same as those chats' own rows.

## Jump keys

Two keys move between workspaces across projects, whatever the strip shows. Their combos are in [the binding table](keyboard-shortcuts.md#jump-keys).

- **Recent walk.** `useRecentWorkspacesStore` (per device) keeps the workspaces you opened, newest first; `WorkspaceShortcutTargetsSubscriber` records each one. The first Tab highlights the workspace you had open before this one, each further Tab goes one older, and Shift goes one newer. On web, `RecentWorkspacesOverlay` lists the walk while the modifier is held and releasing it opens the highlighted workspace. Native has no held walk: each press opens its step at once, so repeated presses flip between the last two workspaces, because hardware keyup there is not reliable enough to end a walk on. Blur ends a walk without opening anything. Entries the sidebar does not list sit out the walk and stay in the list, for the same reason as a stale last chat.
- **Next waiting.** `resolveWaitingWorkspaces` lists every `needs_input` workspace from the unfiltered entries (`allWorkspaceEntriesByKey`), the longest wait first, so a filter never hides one. The key opens the one after the open workspace and wraps. The phone has no key, so the compact sidebar shows a Next waiting button with the count, only while some other workspace is waiting.

## Quiet projects

A project with no chat activity for 3 days folds into "More": on the rail, on the chip row, and at the end of the project list. Any new activity brings it back.

- **Activity** is the newest of a workspace's creation, last prompt, status change, and its root agent's last status change, across the project (`deriveProjectActivity`). A project with nothing known stays out: unknown is not quiet.
- **Never folds by age:** a project with a workspace waiting on you, the project of the open workspace, a project with a pinned workspace, and a project the filter picked. When every awake project would fold, none does.
- **Time** is read hourly (`useQuietProjectKeys`), so a project folds within an hour of crossing 3 days. A snooze's end adds one exact tick, so a snoozed project comes back on the minute.
- **One toggle.** "More" opens on the rail, the chips and the list together (`useSidebarQuietFoldStore`, not persisted, so quiet projects start folded each launch). Opened projects list after the ones that show and don't drag on the rail. Opening it on the chip row scrolls the row so "More" sits at its left edge with the opened chips after it; without that they land past the right edge.
- **One count.** The strip and the list fold from the same projects (`displayProjects` in `sidebar-model.tsx`), so the chip and the list's "More" row show the same number.
- **Digits** count the projects that show first, then the quiet ones, matching the rail.
- The list folds only in project grouping with no project filter. Status grouping has no project rows to fold.

## Snooze

Every project menu (rail and chip right-click or long press, the project row's ⋯ and right-click) has Snooze: until tomorrow, until Monday, or a day in the next two weeks, each at 08:00 local time. A snoozed project folds into "More" whatever the never-fold rules say, since you put it away on purpose. Its chats send no push and no in-app alert, but they still count in Needs you and on the status dots. Wake now, in the same menu, brings it back; so does the time passing.

- **The host owns it.** The snooze is `snoozedUntil` on the project record, set through `project.snooze.set` (gated on `features.projectSnooze`), and rides on the project and workspace descriptors as `projectSnoozedUntil`. Every device sees the same snooze. A project shown once for several hosts is snoozed on each of them and counts as snoozed while any still is.
- **Nothing clears it.** The value stays after the time passes; every reader compares it with now (`isSnoozed` on the daemon, `projectSnoozedUntilMs` in the app). A project never snoozed sends no field; one snoozed before sends `null` once woken, so a client that merges descriptors still sees the wake.
- **Silencing lives on the daemon** (`broadcastAgentAttention`): it skips the push and sends the attention event with `shouldNotify: false`, so unread and status still update.
- "Until a date" lists days instead of a date picker: the app has none, and a list is one tap on a phone.
- To check it again: `npx playwright test --project=browser e2e/browser/sidebar-project-snooze.spec.ts` from `packages/app` snoozes from the rail, checks a second page folds it too, wakes it, then at 390×844 snoozes a chip to a picked day.

## Adding to the strip

Later sidebar features plug in here rather than adding a second switcher:

- Per-project actions go in both menus: `ProjectChip`'s `ContextMenuContent` and `RailProjectButton`'s. Moves share `ProjectMoveItem`.
- Anything that changes what selecting a project does belongs in the callers of `showOnlyProject`: the rail and chip press handlers and the `show-sidebar-project` keyboard route in `use-shortcuts.ts`.
- New per-project marks go beside `ProjectStatusDots`, fed by a hook like `useSidebarProjectStatusCounts` that reads the session store with a value-compared selector.
- Needs you sits between the open toggle and All on the rail, and before All in the chip row ([needs-you.md](needs-you.md)). It opens a page rather than filtering the list, so All stays selected under it.
- Plugin buttons come through `addProjectRailItem` and render under the projects, pinned at the rail's foot by `PluginProjectRailItems` (`plugins/project-rail-items/`). The plugin module owns hosts, routing, the badge hook and its error boundary; the rail passes in `RailIconButton`, so the look stays here. The rail hides with fewer than two projects, and its plugin buttons with it; plugins that need a way in on every layout add a sidebar item too.
