# Sidebar project strip

The project strip switches the sidebar between projects. Desktop shows it as an icon rail on the sidebar's left edge; compact layouts show it as a chip row under the sidebar's nav rows. The first entry, All, shows every project. Code: `packages/app/src/components/sidebar/project-strip.tsx`, rules in `project-strip-model.ts`.

## It reuses sidebar state

The strip owns no store.

- **Selection is the project filter.** Picking a project calls `showOnlyProject`, which sets `projectFilters` to that one key; All clears it. The display menu's Project filter and the strip are two views of one value, so a filter picked in either shows in both. A multi-project filter from the menu marks each of its projects selected in the strip.
- **Order is the sidebar's project order.** `useSidebarOrderStore.projectOrder` orders the strip and the project groups in the list. Moving a project in one moves it in the other. Saves go through `mergeWithRemainder`, so projects a host filter hides keep their place.
- **Numbers are strip positions.** The first nine projects get Cmd/Ctrl+1-9 (Alt+1-9 on web), published through `sidebarShortcutProjects` by `WorkspaceShortcutTargetsSubscriber`. See [keyboard-shortcuts.md](keyboard-shortcuts.md#digit-groups) for how the three digit groups split the modifiers.

## Layout rules

- The strip shows only with two or more projects. With one there is nothing to switch, and the digit keys publish no project targets.
- The desktop rail sits inside the sidebar's width (52 px), below the window chrome row, so the titlebar drag region and the resize handle keep their places.
- Desktop reorders by dragging an icon (`DraggableList` with a drag handle). Compact reorders from each chip's menu (long-press on a phone, right-click on web): Move to first, Move earlier, Move later. A sideways drag on the chip row scrolls it, and on native the row blocks the sidebar's swipe-to-close pan so the scroll wins.

## Last chat

Each project remembers the workspace you last had open in it (`useSidebarLastChatStore`, per device). `WorkspaceShortcutTargetsSubscriber` records it: whenever the open workspace or the project list changes, it finds the open workspace's project and stores the pair. It reads the project list on every change because a workspace opened before its host's directory loaded has no project yet.

- **Desktop:** the project jump and a rail click show the project and reopen that workspace. On the desktop layout the chat sits beside the list, so going back to where you were is one step.
- **Compact:** the jump and a chip tap only change the list. The remembered workspace gets a "last open" tag, one tap away. The tag shows only while the strip shows that one project, and not on the row that is already open.
- A remembered workspace the project no longer lists (archived, moved) is ignored at jump time (`resolveProjectLastChat`), not deleted: a host that has not loaded yet lists nothing, and deleting then would forget every chat on it.
- No remembered workspace: the jump only changes the list. It does not guess one.

## The waiting badge

Each project shows how many of its workspaces have the `needs_input` status, through `countProjectWorkspacesNeedingInput`. It counts every workspace in the project, including collapsed and hidden ones, because the strip is how you find work in a project you are not looking at.

## Adding to the strip

Later sidebar features plug in here rather than adding a second switcher:

- Per-project actions on the chip menu go in `ProjectChip`'s `ContextMenuContent`. The desktop rail has no menu yet; give it one with the same items before adding desktop-only actions.
- Anything that changes what selecting a project does belongs in the callers of `showOnlyProject`: the rail and chip press handlers and the `show-sidebar-project` keyboard route in `use-shortcuts.ts`.
- Badges other than the waiting count go beside `NeedsInputBadge`, fed by a hook like `useSidebarProjectNeedsInputCount` that reads the session store with a primitive selector.
