import { getNextActiveIndex } from "./combobox-keyboard";

export type AutocompleteOptionsPosition = "above-input" | "below-input";

export function orderAutocompleteOptions<T>(
  options: readonly T[],
  position: AutocompleteOptionsPosition = "above-input",
): T[] {
  if (position === "below-input") {
    return [...options];
  }
  return [...options].toReversed();
}

export function getAutocompleteFallbackIndex(
  itemCount: number,
  position: AutocompleteOptionsPosition = "above-input",
): number {
  if (itemCount <= 0) {
    return -1;
  }
  return position === "above-input" ? itemCount - 1 : 0;
}

// Keeps the highlight on the same option when the list changes under it (for
// example when provider commands arrive after the built-ins), so the row the
// user sees highlighted is the one Enter applies. A new query starts over.
export function resolveAutocompleteSelectedIndex<TOption extends { id: string }>(args: {
  previousOptions: readonly TOption[];
  previousIndex: number;
  options: readonly TOption[];
  queryChanged: boolean;
  position?: AutocompleteOptionsPosition;
}): number {
  const fallbackIndex = getAutocompleteFallbackIndex(args.options.length, args.position);
  if (args.queryChanged) {
    return fallbackIndex;
  }
  const selectedId = args.previousOptions[args.previousIndex]?.id;
  if (selectedId === undefined) {
    return fallbackIndex;
  }
  const index = args.options.findIndex((option) => option.id === selectedId);
  return index >= 0 ? index : fallbackIndex;
}

export function getAutocompleteNextIndex(args: {
  currentIndex: number;
  itemCount: number;
  key: "ArrowDown" | "ArrowUp";
}): number {
  return getNextActiveIndex(args);
}
