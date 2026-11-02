export interface TerminalRendererReadyChange {
  streamKey: string;
  isReady: boolean;
}

export function applyTerminalRendererReadyChange(
  currentReadyStreamKey: string | null,
  change: TerminalRendererReadyChange,
): string | null {
  if (change.isReady) {
    return change.streamKey;
  }

  return currentReadyStreamKey === change.streamKey ? null : currentReadyStreamKey;
}

export function resolveTerminalStreamTarget(input: {
  terminalId: string;
  terminalStreamKey: string;
  rendererReadyStreamKey: string | null;
  isWorkspaceFocused: boolean;
  /** This terminal's tab is the one shown in its pane. */
  isPanelActive: boolean;
  isAppVisible: boolean;
  /**
   * Desktop and browser keep hidden tabs of the focused workspace streaming, so switching back
   * needs no fresh snapshot. Phones stream only the terminal on screen while the app is visible:
   * every byte is parsed by a JS terminal emulator and repainted, which costs battery for output
   * nobody sees.
   */
  streamHiddenTabs: boolean;
}): string | null {
  const isStreamDemanded =
    input.isWorkspaceFocused &&
    (input.streamHiddenTabs || (input.isPanelActive && input.isAppVisible));
  return isStreamDemanded && input.rendererReadyStreamKey === input.terminalStreamKey
    ? input.terminalId
    : null;
}

export function shouldShowTerminalLoadingOverlay(input: {
  isWorkspaceFocused: boolean;
  hasStreamError: boolean;
  isAttaching: boolean;
  rendererReadyStreamKey: string | null;
  terminalStreamKey: string;
}): boolean {
  return (
    input.isWorkspaceFocused &&
    !input.hasStreamError &&
    (input.isAttaching || input.rendererReadyStreamKey !== input.terminalStreamKey)
  );
}
