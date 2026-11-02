import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";
import { View, type LayoutChangeEvent } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { ListTerminalsResponse } from "@getpaseo/protocol/messages";
import type {
  TerminalEmulatorHandle,
  TerminalEmulatorProps,
} from "@/components/terminal-emulator-contract";
import { TerminalFloatingAddNoteAction } from "@/components/terminal-copy-paste-actions";
import { getIsElectron, isNative } from "@/constants/platform";
import { useToast } from "@/contexts/toast-context";
import { queryClient } from "@/data/query-client";
import { useStableEvent } from "@/hooks/use-stable-event";
import { openNoteComposer } from "@/notes/composer-store";
import { useNoteFocusStore } from "@/notes/focus-store";
import { noteFired } from "@/notes/model";
import { useHostSupportsNotes, useTerminalNotes } from "@/notes/store";
import { buildTerminalsQueryKey } from "@/screens/workspace/terminals/state";
import { terminalSelectionCommand } from "./command-line";
import { resolveSelectionActionPosition } from "./selection-action-position";
import type { TerminalNoteHighlight, TerminalSelectionAnchor } from "./terminal-note-types";

// The buffer fills in after attach and replay, so a jump retries for a few seconds.
const NOTE_REVEAL_RETRY_MS = 250;
const NOTE_REVEAL_ATTEMPTS = 12;
const EMPTY_NOTE_HIGHLIGHTS: TerminalNoteHighlight[] = [];
const DEFAULT_SELECTION_ACTION_SIZE = { width: 96, height: 28 };

export type TerminalPaneNoteEmulatorProps = Pick<
  TerminalEmulatorProps,
  "onSelectionAnchorChange" | "noteHighlights" | "contextMenuAddNoteLabel" | "onContextMenuAddNote"
>;

/** The floating "Add note" next to a browser selection. */
export interface TerminalSelectionNoteActionState {
  left: number;
  top: number;
  onLayout: (event: LayoutChangeEvent) => void;
}

export interface TerminalPaneNotes {
  supportsNotes: boolean;
  addNote: () => void;
  emulatorProps: TerminalPaneNoteEmulatorProps;
  selectionAction: TerminalSelectionNoteActionState | null;
}

interface TerminalPaneNotesInput {
  serverId: string;
  cwd: string;
  terminalId: string;
  workspaceId: string;
  emulatorRef: RefObject<TerminalEmulatorHandle | null>;
  isTerminalPresented: boolean;
  isRendererReady: boolean;
  isAttaching: boolean;
}

function useAddTerminalNote(input: TerminalPaneNotesInput): () => void {
  const { serverId, cwd, terminalId, workspaceId, emulatorRef } = input;
  return useCallback(() => {
    const selection = emulatorRef.current?.getSelectionNoteContext();
    if (!selection) return;
    const terminals = queryClient.getQueryData<ListTerminalsResponse["payload"]>(
      buildTerminalsQueryKey(serverId, cwd, workspaceId || null),
    );
    const terminal = terminals?.terminals.find((entry) => entry.id === terminalId);
    const terminalName = (terminal?.title ?? terminal?.name ?? "").trim();
    openNoteComposer({
      serverId,
      quote: selection.text,
      anchor: {
        kind: "terminal",
        terminalId,
        ...(workspaceId ? { workspaceId } : {}),
        cwd,
        ...(terminalName ? { terminalName } : {}),
        startLine: Math.max(0, selection.startLine),
        endLine: Math.max(0, selection.endLine),
      },
      terminalId,
      command: terminalSelectionCommand(selection.text),
    });
  }, [cwd, emulatorRef, serverId, terminalId, workspaceId]);
}

function useTerminalNoteHighlights(serverId: string, terminalId: string): TerminalNoteHighlight[] {
  const terminalNotes = useTerminalNotes(serverId, terminalId);
  return useMemo(() => {
    // The native grid draws no highlights.
    if (isNative || terminalNotes.length === 0) return EMPTY_NOTE_HIGHLIGHTS;
    return terminalNotes.map(
      (note): TerminalNoteHighlight => ({
        id: note.id,
        quote: note.quote,
        startLine: note.anchor.kind === "terminal" ? note.anchor.startLine : undefined,
        fired: noteFired(note),
      }),
    );
  }, [terminalNotes]);
}

/** "Jump to note": once this terminal shows its buffer, scroll to the note's quote and select it. */
function useTerminalNoteJump(input: TerminalPaneNotesInput): void {
  const { serverId, terminalId, emulatorRef, isTerminalPresented, isRendererReady, isAttaching } =
    input;
  const { t } = useTranslation();
  const toast = useToast();
  const noteFocusTarget = useNoteFocusStore((state) => state.target);
  const reportNoteQuoteMissing = useStableEvent(() => {
    toast.show(t("notes.terminal.quoteNotFound"));
  });
  useEffect(() => {
    const target = noteFocusTarget;
    const anchor = target?.note.anchor;
    if (!target || target.serverId !== serverId || anchor?.kind !== "terminal") return;
    if (anchor.terminalId !== terminalId) return;
    if (!isTerminalPresented || !isRendererReady || isAttaching) return;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reveal = () => {
      attempts += 1;
      const found =
        emulatorRef.current?.revealNote({
          quote: target.note.quote,
          startLine: anchor.startLine,
        }) ?? false;
      if (!found && attempts < NOTE_REVEAL_ATTEMPTS) {
        timer = setTimeout(reveal, NOTE_REVEAL_RETRY_MS);
        return;
      }
      if (!found) reportNoteQuoteMissing();
      useNoteFocusStore.getState().clear(target.requestId);
    };
    reveal();
    return () => clearTimeout(timer);
  }, [
    emulatorRef,
    isAttaching,
    isRendererReady,
    isTerminalPresented,
    noteFocusTarget,
    reportNoteQuoteMissing,
    serverId,
    terminalId,
  ]);
}

/** Plain browsers get a floating "Add note" next to the selection; Electron uses its menu. */
function useSelectionNoteAction(
  enabled: boolean,
  terminalId: string,
): {
  onSelectionAnchorChange: ((anchor: TerminalSelectionAnchor | null) => void) | undefined;
  selectionAction: TerminalSelectionNoteActionState | null;
} {
  const [anchor, setAnchor] = useState<TerminalSelectionAnchor | null>(null);
  const [size, setSize] = useState(DEFAULT_SELECTION_ACTION_SIZE);
  useEffect(() => {
    setAnchor(null);
  }, [terminalId]);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize((current) =>
      current.width === width && current.height === height ? current : { width, height },
    );
  }, []);
  const selectionAction = useMemo(() => {
    if (!enabled || !anchor) return null;
    const position = resolveSelectionActionPosition(anchor, size);
    return position ? { ...position, onLayout } : null;
  }, [anchor, enabled, onLayout, size]);
  return { onSelectionAnchorChange: enabled ? setAnchor : undefined, selectionAction };
}

/** Everything the terminal pane needs for notes: entry points, highlights and jump. */
export function useTerminalPaneNotes(input: TerminalPaneNotesInput): TerminalPaneNotes {
  const { t } = useTranslation();
  const supportsNotes = useHostSupportsNotes(input.serverId);
  const isElectron = getIsElectron();
  const addNote = useAddTerminalNote(input);
  const noteHighlights = useTerminalNoteHighlights(input.serverId, input.terminalId);
  useTerminalNoteJump(input);
  const { onSelectionAnchorChange, selectionAction } = useSelectionNoteAction(
    supportsNotes && !isNative && !isElectron,
    input.terminalId,
  );
  const contextMenuAddNote = supportsNotes && isElectron;
  const contextMenuAddNoteLabel = contextMenuAddNote ? t("notes.addNote") : undefined;
  const emulatorProps = useMemo(
    (): TerminalPaneNoteEmulatorProps => ({
      onSelectionAnchorChange,
      noteHighlights,
      contextMenuAddNoteLabel,
      onContextMenuAddNote: contextMenuAddNote ? addNote : undefined,
    }),
    [addNote, contextMenuAddNote, contextMenuAddNoteLabel, noteHighlights, onSelectionAnchorChange],
  );
  return { supportsNotes, addNote, emulatorProps, selectionAction };
}

export function TerminalSelectionNoteAction({
  action,
  onAddNote,
}: {
  action: TerminalSelectionNoteActionState | null;
  onAddNote: () => void;
}) {
  const style = useMemo(
    () => (action ? [styles.selectionAction, { left: action.left, top: action.top }] : null),
    [action],
  );
  if (!action || !style) return null;
  return (
    <View style={style} onLayout={action.onLayout} testID="terminal-selection-add-note">
      <TerminalFloatingAddNoteAction onAddNote={onAddNote} />
    </View>
  );
}

const styles = StyleSheet.create({
  selectionAction: {
    position: "absolute",
    zIndex: 2,
  },
});
