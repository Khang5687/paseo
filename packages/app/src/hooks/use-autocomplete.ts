import { useCallback, useEffect, useRef, useState } from "react";
import {
  getAutocompleteFallbackIndex,
  getAutocompleteNextIndex,
  type AutocompleteOptionsPosition,
} from "@/components/ui/autocomplete-utils";

interface AutocompleteKeyPressEvent {
  key: string;
  preventDefault: () => void;
}

interface UseAutocompleteInput<
  TOption,
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

export function useAutocomplete<
  TOption,
  TKeyPressEvent extends AutocompleteKeyPressEvent = AutocompleteKeyPressEvent,
>(input: UseAutocompleteInput<TOption, TKeyPressEvent>): UseAutocompleteResult<TKeyPressEvent> {
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const previousQueryRef = useRef("");
  const navigatedRef = useRef(false);

  useEffect(() => {
    if (!input.isVisible) {
      previousQueryRef.current = input.query;
      navigatedRef.current = false;
      setSelectedIndex(-1);
      return;
    }

    const queryChanged = previousQueryRef.current !== input.query;
    previousQueryRef.current = input.query;
    if (queryChanged) {
      navigatedRef.current = false;
    }

    setSelectedIndex((current) => {
      if (input.options.length === 0) {
        return -1;
      }

      const fallbackIndex = getAutocompleteFallbackIndex(
        input.options.length,
        input.optionsPosition,
      );

      if (queryChanged) {
        return fallbackIndex;
      }
      if (current < 0 || current >= input.options.length) {
        return fallbackIndex;
      }
      return current;
    });
  }, [input.isVisible, input.options.length, input.query, input.optionsPosition]);

  const onKeyPress = useCallback(
    (event: TKeyPressEvent) => {
      if (!input.isVisible || input.options.length === 0) {
        return false;
      }

      if (event.key === "ArrowUp") {
        navigatedRef.current = true;
        event.preventDefault();
        setSelectedIndex((current) =>
          getAutocompleteNextIndex({
            currentIndex: current,
            itemCount: input.options.length,
            key: "ArrowUp",
          }),
        );
        return true;
      }

      if (event.key === "ArrowDown") {
        navigatedRef.current = true;
        event.preventDefault();
        setSelectedIndex((current) =>
          getAutocompleteNextIndex({
            currentIndex: current,
            itemCount: input.options.length,
            key: "ArrowDown",
          }),
        );
        return true;
      }

      if (event.key === "Enter" && input.enterSelects === false && !navigatedRef.current) {
        return false;
      }

      if (event.key === "Tab" || event.key === "Enter") {
        event.preventDefault();
        const fallbackIndex = getAutocompleteFallbackIndex(
          input.options.length,
          input.optionsPosition,
        );
        const resolvedIndex =
          selectedIndex >= 0 && selectedIndex < input.options.length
            ? selectedIndex
            : fallbackIndex;
        const selectedOption = input.options[resolvedIndex];
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
    [input, selectedIndex],
  );

  return {
    selectedIndex,
    onKeyPress,
  };
}
