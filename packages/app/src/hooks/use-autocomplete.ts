import { useCallback, useEffect, useRef, useState } from "react";
import {
  getAutocompleteFallbackIndex,
  getAutocompleteNextIndex,
  resolveAutocompleteSelectedIndex,
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
}

interface UseAutocompleteResult<TKeyPressEvent extends AutocompleteKeyPressEvent> {
  selectedIndex: number;
  onKeyPress: (event: TKeyPressEvent) => boolean;
}

export function useAutocomplete<
  TOption extends { id: string },
  TKeyPressEvent extends AutocompleteKeyPressEvent = AutocompleteKeyPressEvent,
>(input: UseAutocompleteInput<TOption, TKeyPressEvent>): UseAutocompleteResult<TKeyPressEvent> {
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const previousQueryRef = useRef("");
  const previousOptionsRef = useRef<readonly TOption[]>([]);

  useEffect(() => {
    if (!input.isVisible) {
      previousQueryRef.current = input.query;
      setSelectedIndex(-1);
      return;
    }

    const queryChanged = previousQueryRef.current !== input.query;
    previousQueryRef.current = input.query;
    const previousOptions = previousOptionsRef.current;
    previousOptionsRef.current = input.options;

    setSelectedIndex((current) =>
      resolveAutocompleteSelectedIndex({
        previousOptions,
        previousIndex: current,
        options: input.options,
        queryChanged,
        position: input.optionsPosition,
      }),
    );
  }, [input.isVisible, input.options, input.query, input.optionsPosition]);

  const onKeyPress = useCallback(
    (event: TKeyPressEvent) => {
      if (!input.isVisible || input.options.length === 0) {
        return false;
      }

      if (event.key === "ArrowUp") {
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
