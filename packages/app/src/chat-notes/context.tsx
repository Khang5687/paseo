import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TextContextMenuItem } from "react-native-enriched-markdown";
import { openNoteComposer } from "@/notes/composer-store";
import { useAgentNotes, useHostSupportsNotes } from "@/notes/store";
import { useNoteFocusStore, type NoteFocusTarget } from "@/notes/focus-store";
import type { Note } from "@/notes/model";

/** The chat a note entry point belongs to. Null when its host does not support notes. */
export interface ChatNotesTarget {
  serverId: string;
  agentId: string;
  workspaceId?: string;
}

/** What an entry point knows about the passage the owner picked. */
export interface ChatNoteSelection {
  quote: string;
  rowId: string;
  messageId: string;
  role: "user" | "assistant";
  start?: number;
  end?: number;
}

/** The stream row a message renders in, for entry points that cannot read the DOM. */
export interface ChatNoteRowIdentity {
  rowId: string;
  messageId: string;
  role: "user" | "assistant";
}

const EMPTY_NOTES: readonly Note[] = [];
const NO_MARKED_MESSAGES: ReadonlySet<string> = new Set();

const TargetContext = createContext<ChatNotesTarget | null>(null);
const NotesContext = createContext<readonly Note[]>(EMPTY_NOTES);
const MarkedMessagesContext = createContext<ReadonlySet<string>>(NO_MARKED_MESSAGES);
const RowContext = createContext<ChatNoteRowIdentity | null>(null);

interface ChatNoteRowProviderProps extends ChatNoteRowIdentity {
  children: ReactNode;
}

/** Names the stream row below it, so its message text can offer "Add note". */
export function ChatNoteRowProvider({
  rowId,
  messageId,
  role,
  children,
}: ChatNoteRowProviderProps) {
  const value = useMemo(() => ({ rowId, messageId, role }), [rowId, messageId, role]);
  return <RowContext.Provider value={value}>{children}</RowContext.Provider>;
}

export function useChatNoteRow(): ChatNoteRowIdentity | null {
  return useContext(RowContext);
}

interface ChatNotesProviderProps extends ChatNotesTarget {
  children: ReactNode;
}

/**
 * Subscribes to the chat's notes while mounted and offers them to rows and surfaces below. The
 * tree is the same whether or not the host supports notes, so the stream never remounts when
 * its host connects; only the target, which every entry point is gated on, turns null.
 */
export function ChatNotesProvider({
  serverId,
  agentId,
  workspaceId,
  children,
}: ChatNotesProviderProps) {
  const supported = useHostSupportsNotes(serverId);
  const notes = useAgentNotes(serverId, agentId);
  const target = useMemo(
    () => (supported ? { serverId, agentId, workspaceId } : null),
    [supported, serverId, agentId, workspaceId],
  );
  const visibleNotes = supported ? notes : EMPTY_NOTES;
  const marked = useMemo(() => {
    const ids = new Set<string>();
    for (const note of visibleNotes) {
      if (note.anchor.kind !== "agent") continue;
      if (note.anchor.messageId) ids.add(note.anchor.messageId);
      if (note.anchor.rowId) ids.add(note.anchor.rowId);
    }
    return ids;
  }, [visibleNotes]);
  return (
    <TargetContext.Provider value={target}>
      <NotesContext.Provider value={visibleNotes}>
        <MarkedMessagesContext.Provider value={marked}>{children}</MarkedMessagesContext.Provider>
      </NotesContext.Provider>
    </TargetContext.Provider>
  );
}

/** The chat to attach notes to, or null when notes are unavailable here. */
export function useChatNotesTarget(): ChatNotesTarget | null {
  return useContext(TargetContext);
}

/** This chat's notes, for highlights and jumps. */
export function useChatNotes(): readonly Note[] {
  return useContext(NotesContext);
}

/** Row and message ids that carry at least one note, for a cheap marker on native. */
export function useChatNoteMarkedMessages(): ReadonlySet<string> {
  return useContext(MarkedMessagesContext);
}

/** A pending "jump to note" aimed at this chat, or null. */
export function useChatNoteFocusTarget(): NoteFocusTarget | null {
  const chat = useChatNotesTarget();
  return useNoteFocusStore((state) => {
    const target = state.target;
    if (!chat || !target || target.serverId !== chat.serverId) return null;
    const anchor = target.note.anchor;
    return anchor.kind === "agent" && anchor.agentId === chat.agentId ? target : null;
  });
}

/**
 * Message-level "Add note" for the row below a `ChatNoteRowProvider`, quoting the whole message.
 * Null when the chat has no notes or the row is unnamed.
 */
export function useAddMessageNote(getQuote: () => string): {
  onPress: () => void;
  marked: boolean;
} | null {
  const target = useChatNotesTarget();
  const row = useChatNoteRow();
  const marked = useChatNoteMarkedMessages();
  const onPress = useCallback(() => {
    if (target && row) openChatNoteComposer(target, { ...row, quote: getQuote() });
  }, [getQuote, row, target]);
  if (!target || !row) return null;
  return { onPress, marked: marked.has(row.messageId) || marked.has(row.rowId) };
}

/**
 * The native selection menu's "Add note" for assistant text below a `ChatNoteRowProvider`. The
 * library reports offsets into one native text fragment, not the row's rendered web text, so the
 * note keeps only the quote and its row.
 */
export function useChatNoteContextMenuItems(): TextContextMenuItem[] | undefined {
  const { t } = useTranslation();
  const target = useChatNotesTarget();
  const row = useChatNoteRow();
  return useMemo(() => {
    if (!target || !row) return undefined;
    return [
      {
        text: t("notes.addNote"),
        icon: "note.text.badge.plus",
        onPress: ({ text }) => openChatNoteComposer(target, { ...row, quote: text }),
      },
    ];
  }, [row, t, target]);
}

export function openChatNoteComposer(target: ChatNotesTarget, selection: ChatNoteSelection): void {
  const quote = selection.quote.trim();
  if (!quote) return;
  openNoteComposer({
    serverId: target.serverId,
    quote,
    agentId: target.agentId,
    anchor: {
      kind: "agent",
      agentId: target.agentId,
      workspaceId: target.workspaceId,
      rowId: selection.rowId,
      messageId: selection.messageId,
      role: selection.role,
      start: selection.start,
      end: selection.end,
    },
  });
}
