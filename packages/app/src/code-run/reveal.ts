import type { EditingTextInputHandle } from "@/components/ui/text-input";

/**
 * Native chat content rides the keyboard: the stream translates by the keyboard height
 * (`keyboard/shift`), so a focused field in a card stays above it without a scroll here.
 */
export function revealField(_field: EditingTextInputHandle): void {}
