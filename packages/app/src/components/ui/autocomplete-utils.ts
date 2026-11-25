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

/** An arrow-key choice: the option it picked and the query it was made for. */
export interface AutocompleteChoice {
  id: string;
  query: string;
}

// Keeps the highlight on the chosen option when the list changes under it (for
// example when a refetch adds commands above it), so the row the user sees
// highlighted is the one Enter applies. A choice made for another query, or whose
// option is gone, falls back to the option nearest the input.
export function resolveAutocompleteSelectedIndex<TOption extends { id: string }>(args: {
  choice: AutocompleteChoice | null;
  query: string;
  options: readonly TOption[];
  position?: AutocompleteOptionsPosition;
}): number {
  const fallbackIndex = getAutocompleteFallbackIndex(args.options.length, args.position);
  const { choice } = args;
  if (!choice || choice.query !== args.query) {
    return fallbackIndex;
  }
  const index = args.options.findIndex((option) => option.id === choice.id);
  return index >= 0 ? index : fallbackIndex;
}

export function getAutocompleteNextIndex(args: {
  currentIndex: number;
  itemCount: number;
  key: "ArrowDown" | "ArrowUp";
}): number {
  return getNextActiveIndex(args);
}
