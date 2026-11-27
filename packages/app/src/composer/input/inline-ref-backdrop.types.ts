import type { StoreApi } from "zustand/vanilla";

export interface InlineRefBackdropProps {
  /** The composer's live text, published on every edit and replacement. */
  textStore: StoreApi<string>;
  textarea: HTMLElement | null;
}
