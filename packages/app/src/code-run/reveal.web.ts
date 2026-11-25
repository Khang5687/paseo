import type { EditingTextInputHandle } from "@/components/ui/text-input";

/** A phone browser's keyboard covers the lower page; keep the focused answer field visible. */
export function revealField(field: EditingTextInputHandle): void {
  const node = field.getNativeRef();
  if (node instanceof HTMLElement) node.scrollIntoView({ block: "nearest" });
}
