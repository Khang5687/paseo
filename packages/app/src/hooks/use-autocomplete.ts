import { useCallback, useEffect, useState } from "react";
import {
  getAutocompleteNextIndex,
  resolveAutocompleteSelectedIndex,
  type AutocompleteChoice,
  type AutocompleteOptionsPosition,
} from "@/components/ui/autocomplete-utils";

interface AutocompleteKeyPressEvent {
  key: string;
  preventDefault: () => void;
}

interface UseAutocompleteInput<
  TOption extends { id: string },
  TKeyPressEvent extends AutocompleteKeyPressEvent = AutocompleteKeyPressEvent,
> {
  isVisible: boolean;
  options: readonly TOption[];
  query: string;
  onSelectOption: (option: TOption, event?: TKeyPressEvent) => void;
  onEscape?: () => void;
  optionsPosition?: AutocompleteOptionsPosition;
  /**
   * When false, Enter is left to the input (it sends) until the user moves the
   * selection with the arrow keys; Tab still picks. Defaults to true.
   */
  enterSelects?: boolean;
}

interface UseAutocompleteResult<TKeyPressEvent extends AutocompleteKeyPressEvent> {
  selectedIndex: number;
  onKeyPress: (event: TKeyPressEvent) => boolean;
}

const NO_OPTIONS: readonly never[] = [];

export function useAutocomplete<
  TOption extends { id: string },
  TKeyPressEvent extends AutocompleteKeyPressEvent = AutocompleteKeyPressEvent,
>(input: UseAutocompleteInput<TOption, TKeyPressEvent>): UseAutocompleteResult<TKeyPressEvent> {
  // The user's choice, tied to the query it was made for. The shown index is resolved from it
  // during render, so a list never paints its first frame without a selection: the popover only
  // measures once a non-empty list has one.
  const [choice, setChoice] = useState<AutocompleteChoice | null>(null);
  const shownOptions = input.isVisible ? input.options : NO_OPTIONS;
  const selectedIndex = resolveAutocompleteSelectedIndex({
    choice,
    query: input.query,
    options: shownOptions,
    position: input.optionsPosition,
  });
  const isChosen =
    choice !== null &&
    choice.query === input.query &&
    shownOptions[selectedIndex]?.id === choice.id;

  // A choice belongs to one search. Until this clears it, the query check above ignores it.
  useEffect(() => {
    setChoice(null);
  }, [input.isVisible, input.query]);

  const onKeyPress = useCallback(
    (event: TKeyPressEvent) => {
      if (!input.isVisible || input.options.length === 0) {
        return false;
      }

      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        const nextIndex = getAutocompleteNextIndex({
          currentIndex: selectedIndex,
          itemCount: input.options.length,
          key: event.key,
        });
        const nextOption = input.options[nextIndex];
        setChoice(nextOption ? { id: nextOption.id, query: input.query } : null);
        return true;
      }

      if (event.key === "Enter" && input.enterSelects === false && !isChosen) {
        return false;
      }

      if (event.key === "Tab" || event.key === "Enter") {
        event.preventDefault();
        const selectedOption = input.options[selectedIndex];
        if (selectedOption) {
          input.onSelectOption(selectedOption, event);
        }
        return true;
      }

      if (event.key === "Escape" && input.onEscape) {
        event.preventDefault();
        input.onEscape();
        return true;
      }

      return false;
    },
    [input, isChosen, selectedIndex],
  );

  return {
    selectedIndex,
    onKeyPress,
  };
}
