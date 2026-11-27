function preventDefault(event: Event): void {
  event.preventDefault();
}

function swallowTouchEndAfter(event: PointerEvent): void {
  if (event.pointerType !== "touch") return;
  document.addEventListener("touchend", preventDefault, { capture: true, once: true });
}

/**
 * Call from a long press that opens an overlay under the finger. When the finger lifts, the
 * browser sends the compatibility mousedown and click to whatever is under it now, the overlay's
 * backdrop, which closes the overlay at once. Cancelling that touch's touchend drops them.
 * A mouse release is left alone.
 */
export function swallowTouchRelease(): void {
  document.addEventListener("pointerup", swallowTouchEndAfter, { capture: true, once: true });
}
