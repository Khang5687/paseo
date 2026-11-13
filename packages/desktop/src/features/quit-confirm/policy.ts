// Cmd+Q asks for confirmation the way Chrome's "Warn before quitting" does:
// the first press shows a toast, and the app quits on a second press while the
// toast is up or when the shortcut is held for QUIT_HOLD_MS.
//
// Holding is detected from auto-repeat keyDowns, not from keyUp. macOS swallows
// the keyUp of a key pressed together with Command, so "still holding" can only
// be observed as repeats arriving. Repeats stop the moment Q is released.

export const QUIT_HOLD_MS = 1000;
export const QUIT_CONFIRM_WINDOW_MS = 2000;

export interface QuitShortcutInput {
  type: string;
  key: string;
  meta: boolean;
  control: boolean;
  alt: boolean;
  shift: boolean;
}

export function isQuitShortcut(input: QuitShortcutInput): boolean {
  return (
    input.type === "keyDown" &&
    input.meta &&
    !input.control &&
    !input.alt &&
    !input.shift &&
    input.key.toLowerCase() === "q"
  );
}

export interface QuitConfirmEffects {
  showToast(): void;
  hideToast(): void;
  quit(): void;
}

export interface QuitConfirm {
  press(input: { repeat: boolean }): void;
}

export function createQuitConfirm(effects: QuitConfirmEffects): QuitConfirm {
  let armedAt: number | null = null;
  let disarmTimer: NodeJS.Timeout | null = null;

  function clearDisarmTimer(): void {
    if (disarmTimer !== null) {
      clearTimeout(disarmTimer);
      disarmTimer = null;
    }
  }

  function disarm(): void {
    clearDisarmTimer();
    armedAt = null;
    effects.hideToast();
  }

  // Every press, including each repeat of a held key, keeps the toast up so it
  // never disappears under a finger that is still holding the shortcut.
  function extendConfirmWindow(): void {
    clearDisarmTimer();
    disarmTimer = setTimeout(disarm, QUIT_CONFIRM_WINDOW_MS);
  }

  return {
    press({ repeat }) {
      const now = Date.now();
      if (armedAt === null) {
        armedAt = now;
        effects.showToast();
        extendConfirmWindow();
        return;
      }
      if (!repeat || now - armedAt >= QUIT_HOLD_MS) {
        disarm();
        effects.quit();
        return;
      }
      extendConfirmWindow();
    },
  };
}
