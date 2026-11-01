import type {
  TerminalFindHandle,
  TerminalFindResult,
} from "../terminal/runtime/terminal-emulator-runtime";
import type { Ref } from "react";
import type { ITheme } from "@xterm/xterm";
import type { TerminalInputModeState } from "@getpaseo/protocol/terminal-input-mode";
import type { TerminalOutputData } from "../terminal/runtime/terminal-emulator-runtime";
import type {
  TerminalLocalFileLinkSource,
  TerminalLocalFileLinkTarget,
} from "../terminal/local-links/terminal-local-link-provider";
import type { TerminalClipboardWriter } from "../terminal/native-renderer/terminal-selection";
import type { TerminalFile } from "../terminal/file-paste";
import type { PendingTerminalModifiers } from "../utils/terminal-keys";
import type { TerminalRendererReadyChange } from "../utils/terminal-renderer-readiness";
import type {
  TerminalNoteHighlight,
  TerminalNoteReveal,
  TerminalSelectionAnchor,
  TerminalSelectionNoteContext,
} from "../terminal/notes/terminal-note-types";

export interface TerminalEmulatorHandle {
  find?: TerminalFindHandle;
  writeOutput: (data: TerminalOutputData) => void;
  replay: (event: import("@getpaseo/client").TerminalReplayEvent) => void;
  paste: (text: string) => void;
  copySelection: (clipboard: TerminalClipboardWriter) => Promise<string>;
  clear: () => void;
  claimSize: () => void;
  showKeyboard: () => void;
  blur: () => void;
  /** The selection an "Add note" draft quotes, or null without a selection. */
  getSelectionNoteContext: () => TerminalSelectionNoteContext | null;
  /** Scroll to a note's quote and select it; false when the buffer no longer holds it. */
  revealNote: (input: TerminalNoteReveal) => boolean;
}

export interface TerminalEmulatorProps {
  dom?: unknown;
  ref: Ref<TerminalEmulatorHandle>;
  streamKey: string;
  supportsTerminalInputModeReplay: boolean;
  testId?: string;
  xtermTheme?: ITheme;
  scrollbackLines: number;
  fontFamily?: string;
  fontSize?: number;
  keyboardInset?: number;
  isKeyboardVisible?: boolean;
  swipeGesturesEnabled?: boolean;
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  onFindRequest?: () => void;
  onFindResult?: (result: TerminalFindResult) => void;
  onInput?: (data: string) => Promise<void> | void;
  onFocus?: () => Promise<void> | void;
  onResize?: (input: {
    rows: number;
    cols: number;
    shouldClaim: boolean;
    forceClaim?: boolean;
  }) => Promise<void> | void;
  onTerminalKey?: (input: {
    key: string;
    ctrl: boolean;
    shift: boolean;
    alt: boolean;
    meta: boolean;
  }) => Promise<void> | void;
  onPendingModifiersConsumed?: () => Promise<void> | void;
  onInputModeChange?: (state: TerminalInputModeState) => Promise<void> | void;
  onSelectionChange?: (hasSelection: boolean) => void;
  /** Web only: where the selection sits, for a floating action next to it. */
  onSelectionAnchorChange?: (anchor: TerminalSelectionAnchor | null) => void;
  /** Web only: notes drawn over their quotes. */
  noteHighlights?: readonly TerminalNoteHighlight[];
  /** Electron only: label of the context menu's "Add note" item; omitted hides the item. */
  contextMenuAddNoteLabel?: string;
  onContextMenuAddNote?: () => void;
  onResolveLocalFileLink?: (
    source: TerminalLocalFileLinkSource,
  ) => Promise<TerminalLocalFileLinkTarget | null> | TerminalLocalFileLinkTarget | null;
  onOpenLocalFileLink?: (
    target: TerminalLocalFileLinkTarget,
    disposition: "main" | "side",
  ) => Promise<void> | void;
  onRendererReadyChange?: (change: TerminalRendererReadyChange) => void;
  pendingModifiers?: PendingTerminalModifiers;
  focusRequestToken?: number;
  resizeRequestToken?: number;
  onFilePaste?: (file: Promise<TerminalFile | null>) => void;
}
