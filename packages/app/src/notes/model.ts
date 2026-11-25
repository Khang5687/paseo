import type {
  Note,
  NoteAnchor,
  NoteCommandCondition,
  NoteWait,
  NoteWaitResult,
} from "@getpaseo/protocol/notes/schemas";

export type { Note, NoteAnchor, NoteCommandCondition, NoteWait, NoteWaitResult };

export type NoteChange = { kind: "upsert"; note: Note } | { kind: "remove"; noteId: string };

/** A note tagged with the host that owns it, so one list can span hosts. */
export interface HostNote extends Note {
  serverId: string;
  serverName: string;
}

/**
 * - `waiting`: a waiting-on note whose event has not happened (a blocker).
 * - `open`: a plain note, or a waiting-on note whose event happened without matching its
 *   condition (a command succeeded while the note waited for a failure).
 * - `resolved`: resolved by its event or by the owner.
 */
export type NoteState = "waiting" | "open" | "resolved";

export type NoteFilter = "all" | NoteState;

export function noteState(note: Note): NoteState {
  if (note.resolvedAt) return "resolved";
  if (note.wait && !note.waitResult) return "waiting";
  return "open";
}

/** True when the note was resolved because its event fired (drawn green). */
export function noteFired(note: Note): boolean {
  return note.resolvedAt != null && note.waitResult?.matched === true;
}

/**
 * How a note is drawn over its text and marked on its message: a plain note, a note waiting on
 * its event, one its event resolved (green), or one the owner resolved by hand.
 */
export type NoteHighlightKind = "open" | "waiting" | "fired" | "resolved";

export function noteHighlightKind(note: Note): NoteHighlightKind {
  const state = noteState(note);
  if (state !== "resolved") return state;
  return noteFired(note) ? "fired" : "resolved";
}

const HIGHLIGHT_KIND_ORDER: Record<NoteHighlightKind, number> = {
  waiting: 0,
  fired: 1,
  open: 2,
  resolved: 3,
};

/** The kind one marker shows for several notes on the same message: blockers win. */
export function strongestNoteHighlightKind(notes: readonly Note[]): NoteHighlightKind | null {
  let strongest: NoteHighlightKind | null = null;
  for (const note of notes) {
    const kind = noteHighlightKind(note);
    if (strongest === null || HIGHLIGHT_KIND_ORDER[kind] < HIGHLIGHT_KIND_ORDER[strongest]) {
      strongest = kind;
    }
  }
  return strongest;
}

const STATE_ORDER: Record<NoteState, number> = { waiting: 0, open: 1, resolved: 2 };

/** Blockers first, then open notes, then resolved ones; newest first inside each group. */
export function compareNotes(a: Note, b: Note): number {
  const byState = STATE_ORDER[noteState(a)] - STATE_ORDER[noteState(b)];
  if (byState !== 0) return byState;
  const aTime = a.resolvedAt ?? a.createdAt;
  const bTime = b.resolvedAt ?? b.createdAt;
  return bTime.localeCompare(aTime) || a.id.localeCompare(b.id);
}

export function applyNoteChange(notes: readonly Note[], change: NoteChange): Note[] {
  if (change.kind === "remove") return notes.filter((note) => note.id !== change.noteId);
  const index = notes.findIndex((note) => note.id === change.note.id);
  if (index === -1) return [...notes, change.note];
  // An older update can arrive after a mutation response already applied a newer one.
  if (notes[index].updatedAt > change.note.updatedAt) return [...notes];
  const next = [...notes];
  next[index] = change.note;
  return next;
}

export interface NotesHostInput {
  serverId: string;
  serverName: string;
  notes: readonly Note[];
}

/** One list across hosts, sorted with blockers on top. */
export function mergeHostNotes(hosts: readonly NotesHostInput[]): HostNote[] {
  const merged: HostNote[] = [];
  for (const host of hosts) {
    for (const note of host.notes) {
      merged.push({ ...note, serverId: host.serverId, serverName: host.serverName });
    }
  }
  return merged.sort((a, b) => compareNotes(a, b) || a.serverId.localeCompare(b.serverId));
}

export function filterNotes<T extends Note>(notes: readonly T[], filter: NoteFilter): T[] {
  if (filter === "all") return [...notes];
  return notes.filter((note) => noteState(note) === filter);
}

export function notesForAgent<T extends Note>(notes: readonly T[], agentId: string): T[] {
  return notes.filter((note) => note.anchor.kind === "agent" && note.anchor.agentId === agentId);
}

export function notesForTerminal<T extends Note>(notes: readonly T[], terminalId: string): T[] {
  return notes.filter(
    (note) => note.anchor.kind === "terminal" && note.anchor.terminalId === terminalId,
  );
}
