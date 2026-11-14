/**
 * Which sidebar rows are ticked for a bulk action. Keys are `workspaceKey`s. Off means the
 * sidebar behaves normally; on means a row press ticks the row instead of opening it.
 */
export type SidebarSelection =
  | { active: false }
  | { active: true; keys: ReadonlySet<string>; anchorKey: string | null };

export const INACTIVE_SIDEBAR_SELECTION: SidebarSelection = { active: false };

export type SidebarRowPressIntent = "open" | "toggle" | "range";

export interface SidebarRowPressModifiers {
  /** Cmd on macOS, Ctrl elsewhere. */
  toggle: boolean;
  shift: boolean;
}

export function resolveSidebarRowPressIntent(input: {
  selection: SidebarSelection;
  modifiers: SidebarRowPressModifiers;
}): SidebarRowPressIntent {
  if (input.modifiers.shift) return "range";
  if (input.modifiers.toggle || input.selection.active) return "toggle";
  return "open";
}

export function startSidebarSelection(key: string | null): SidebarSelection {
  return { active: true, keys: key ? new Set([key]) : new Set(), anchorKey: key };
}

export function toggleSidebarSelection(selection: SidebarSelection, key: string): SidebarSelection {
  if (!selection.active) return startSidebarSelection(key);
  const keys = new Set(selection.keys);
  if (keys.has(key)) keys.delete(key);
  else keys.add(key);
  return { active: true, keys, anchorKey: key };
}

/** Ticks a row without unticking it when it already is. */
export function addToSidebarSelection(selection: SidebarSelection, key: string): SidebarSelection {
  if (!selection.active) return startSidebarSelection(key);
  if (selection.keys.has(key)) return { ...selection, anchorKey: key };
  return { active: true, keys: new Set(selection.keys).add(key), anchorKey: key };
}

/**
 * Ticks every visible row from the anchor to `key`, keeping what was already ticked. The anchor
 * is the last row ticked, or `fallbackAnchorKey` (the open workspace) when nothing was. Without a
 * visible anchor there is no range, so only `key` is ticked.
 */
export function selectSidebarRange(
  selection: SidebarSelection,
  input: {
    key: string;
    visibleKeys: readonly string[];
    fallbackAnchorKey: string | null;
  },
): SidebarSelection {
  const anchorKey = selection.active ? selection.anchorKey : input.fallbackAnchorKey;
  const anchorIndex = anchorKey ? input.visibleKeys.indexOf(anchorKey) : -1;
  const keyIndex = input.visibleKeys.indexOf(input.key);
  if (anchorIndex === -1 || keyIndex === -1) {
    return addToSidebarSelection(selection, input.key);
  }

  const start = Math.min(anchorIndex, keyIndex);
  const end = Math.max(anchorIndex, keyIndex);
  const keys = new Set(selection.active ? selection.keys : []);
  for (const rangeKey of input.visibleKeys.slice(start, end + 1)) {
    keys.add(rangeKey);
  }
  return { active: true, keys, anchorKey: input.key };
}
