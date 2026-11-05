import type { InlineRefBackdropProps } from "./inline-ref-backdrop.types";

// ponytail: native keeps tokens as plain text. TextInput children could style the ranges, but
// the composer's input is uncontrolled (PasteInput on native), and styled children would make
// React own its text on every keystroke.
export function InlineRefBackdrop(_props: InlineRefBackdropProps): null {
  return null;
}
