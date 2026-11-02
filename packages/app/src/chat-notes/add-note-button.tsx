import { memo } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { CircleCheck, Clock, StickyNote, StickyNotePlus } from "lucide-react-native";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { isNative } from "@/constants/platform";
import type { NoteHighlightKind } from "@/notes/model";
import { ICON_SIZE } from "@/styles/theme";
import { useAddMessageNote, useMessageNoteMarker, type MessageNoteMarker } from "./context";

interface AddNoteButtonProps {
  onPress: () => void;
  /** The message's notes, if any: the icon shows their kind, since native draws no highlight. */
  marker?: MessageNoteMarker | null;
}

function NoteKindIcon({ kind }: { kind: NoteHighlightKind }) {
  switch (kind) {
    case "waiting":
      return <Clock size={ICON_SIZE.sm} color={styles.waiting.color} />;
    case "fired":
      return <CircleCheck size={ICON_SIZE.sm} color={styles.fired.color} />;
    case "open":
      return <StickyNote size={ICON_SIZE.sm} color={styles.open.color} />;
    case "resolved":
      return <StickyNote size={ICON_SIZE.sm} color={styles.idle.color} />;
  }
}

/** Message-level "Add note", the touch path where a selection menu cannot offer it. */
const AddNoteButton = memo(function AddNoteButton({ onPress, marker }: AddNoteButtonProps) {
  const { t } = useTranslation();
  const label = marker
    ? `${t("notes.addNote")}. ${t(`notes.marker.${marker.kind}`, { count: marker.count })}`
    : t("notes.addNote");
  return (
    <ToolbarButton label={label} onPress={onPress} compact testID="message-add-note">
      {marker ? (
        <NoteKindIcon kind={marker.kind} />
      ) : (
        <StickyNotePlus size={ICON_SIZE.sm} color={styles.idle.color} />
      )}
    </ToolbarButton>
  );
});

/**
 * Web's mark for a message holding a note that waits on an event. The highlight shows where the
 * note is but cannot carry an icon; tapping the clock opens the note.
 */
const WaitingNoteMarker = memo(function WaitingNoteMarker({
  marker,
}: {
  marker: MessageNoteMarker;
}) {
  const { t } = useTranslation();
  return (
    <ToolbarButton
      label={t("notes.marker.waiting", { count: marker.count })}
      onPress={marker.openNote}
      compact
      testID="message-note-waiting"
    >
      <NoteKindIcon kind="waiting" />
    </ToolbarButton>
  );
});

/**
 * A message's note controls: on native the "Add note" button, iconed by the kind of note the
 * message holds; on web the clock of a waiting note, since web adds notes from the selection.
 */
export function MessageNoteControls({ getQuote }: { getQuote: () => string }) {
  const addNote = useAddMessageNote(getQuote);
  const marker = useMessageNoteMarker();
  if (isNative) return addNote ? <AddNoteButton onPress={addNote} marker={marker} /> : null;
  return marker?.kind === "waiting" ? <WaitingNoteMarker marker={marker} /> : null;
}

const styles = StyleSheet.create((theme) => ({
  idle: {
    color: theme.colors.foregroundMuted,
  },
  open: {
    color: theme.colors.foreground,
  },
  waiting: {
    color: theme.colors.statusWarning,
  },
  fired: {
    color: theme.colors.statusSuccess,
  },
}));
