import { noteFired, noteState, type HostNote, type NoteCommandCondition } from "@/notes/model";

/** What the row's badge says. `open` is a plain note and draws no badge. */
export type NoteRowStatus =
  | { kind: "waiting" }
  | { kind: "fired"; detail: string | null }
  | { kind: "resolved" }
  | { kind: "unmatched"; detail: string | null }
  | { kind: "open" };

/** What a still-waiting note is waiting on, before it is worded. */
export type NoteWaitDescription =
  | { kind: "agent"; agentName: string | null }
  | { kind: "command"; condition: NoteCommandCondition; command: string | null }
  | { kind: "time"; at: Date };

export interface NoteRowSource {
  kind: "agent" | "terminal";
  /** Null when only one host exists and naming it would be noise. */
  hostName: string | null;
  /** Agent title or terminal name; null when unknown, so the row falls back to a generic label. */
  name: string | null;
}

export interface NoteRowModel {
  key: string;
  serverId: string;
  /** The owner's text, or the quote when the note has none. */
  title: string;
  /** The quoted snippet under the title; null when the title already is the quote. */
  quote: string | null;
  source: NoteRowSource;
  /** Set only while the note is waiting. */
  wait: NoteWaitDescription | null;
  status: NoteRowStatus;
  resolved: boolean;
}

export type AgentTitleLookup = (serverId: string, agentId: string) => string | null;

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function describeStatus(note: HostNote): NoteRowStatus {
  const state = noteState(note);
  if (state === "waiting") return { kind: "waiting" };
  const detail = nonEmpty(note.waitResult?.detail);
  if (state === "resolved") {
    return noteFired(note) ? { kind: "fired", detail } : { kind: "resolved" };
  }
  if (note.wait && note.waitResult && !note.waitResult.matched) {
    return { kind: "unmatched", detail };
  }
  return { kind: "open" };
}

function describeWait(note: HostNote, agentTitle: AgentTitleLookup): NoteWaitDescription | null {
  const { wait } = note;
  if (!wait || noteState(note) !== "waiting") return null;
  switch (wait.type) {
    case "agent":
      return {
        kind: "agent",
        agentName: nonEmpty(agentTitle(note.serverId, wait.agentId)) ?? nonEmpty(wait.agentTitle),
      };
    case "terminal-command":
      return { kind: "command", condition: wait.condition, command: nonEmpty(wait.command) };
    case "time":
      return { kind: "time", at: new Date(wait.at) };
  }
}

function describeSource(
  note: HostNote,
  agentTitle: AgentTitleLookup,
  singleHost: boolean,
): NoteRowSource {
  const hostName = singleHost ? null : note.serverName;
  const { anchor } = note;
  if (anchor.kind === "agent") {
    return { kind: "agent", hostName, name: nonEmpty(agentTitle(note.serverId, anchor.agentId)) };
  }
  return { kind: "terminal", hostName, name: nonEmpty(anchor.terminalName) };
}

export function buildNoteRowModel(input: {
  note: HostNote;
  agentTitle: AgentTitleLookup;
  singleHost: boolean;
}): NoteRowModel {
  const { note, agentTitle, singleHost } = input;
  const text = nonEmpty(note.text);
  const quote = nonEmpty(note.quote);
  return {
    key: `${note.serverId}:${note.id}`,
    serverId: note.serverId,
    title: text ?? quote ?? "",
    quote: text ? quote : null,
    source: describeSource(note, agentTitle, singleHost),
    wait: describeWait(note, agentTitle),
    status: describeStatus(note),
    resolved: note.resolvedAt != null,
  };
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export interface TimeUntil {
  unit: "minute" | "hour" | "day";
  count: number;
}

/** How far off a future instant is ("in 5m", "in 2h", "in 3d"); null once it has passed. */
export function describeTimeUntil(at: Date, now: Date): TimeUntil | null {
  const remainingMs = at.getTime() - now.getTime();
  if (remainingMs <= 0) return null;
  // Minutes round up so the last minute reads "in 1m" rather than "in 0m".
  if (remainingMs < HOUR_MS) return { unit: "minute", count: Math.ceil(remainingMs / MINUTE_MS) };
  if (remainingMs < DAY_MS) return { unit: "hour", count: Math.floor(remainingMs / HOUR_MS) };
  return { unit: "day", count: Math.floor(remainingMs / DAY_MS) };
}

/** Which local calendar day a reminder falls on, relative to now. */
export function reminderDay(at: Date, now: Date): "today" | "tomorrow" | "other" {
  const startOfDay = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  // Rounded so a 23- or 25-hour DST day still counts as one.
  const days = Math.round((startOfDay(at) - startOfDay(now)) / DAY_MS);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return "other";
}
