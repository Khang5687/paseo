import { noteFired, noteState, type Note } from "./model";

/** What a sidebar row shows for the chats it stands for. */
export interface ChatNoteBadge {
  /** Notes still waiting on their event. */
  waiting: number;
  /** Notes whose event fired after the owner last had their chat open. */
  fired: number;
}

export const EMPTY_CHAT_NOTE_BADGE: ChatNoteBadge = { waiting: 0, fired: 0 };

/** One chat across hosts: agent ids are unique only on their own host. */
export function chatNotesKey(serverId: string, agentId: string): string {
  return `${serverId}:${agentId}`;
}

export interface ChatNotesSeen {
  /** Notes that fired before this device started tracking count as seen. */
  since: string;
  /** Chat key → when the owner last had that chat open with a fired note in it. */
  seenAt: Readonly<Record<string, string>>;
}

/** When the note's event fired, or null when it has not (or the owner resolved it by hand). */
export function noteFiredAt(note: Note): string | null {
  if (!noteFired(note)) return null;
  return note.waitResult?.at ?? note.resolvedAt ?? null;
}

/**
 * The badge for a row standing for these chats on one host: a thread row passes every agent in its
 * workspace, a sub-agent row passes its own. Terminal notes belong to no chat and never count.
 */
export function chatNoteBadge(input: {
  serverId: string;
  agentIds: readonly string[];
  notes: readonly Note[];
  seen: ChatNotesSeen;
}): ChatNoteBadge {
  const { serverId, agentIds, notes, seen } = input;
  if (agentIds.length === 0 || notes.length === 0) return EMPTY_CHAT_NOTE_BADGE;
  const agents = new Set(agentIds);
  let waiting = 0;
  let fired = 0;
  for (const note of notes) {
    if (note.anchor.kind !== "agent" || !agents.has(note.anchor.agentId)) continue;
    const agentId = note.anchor.agentId;
    if (noteState(note) === "waiting") {
      waiting += 1;
      continue;
    }
    const firedAt = noteFiredAt(note);
    if (!firedAt || firedAt <= seen.since) continue;
    const seenAt = seen.seenAt[chatNotesKey(serverId, agentId)];
    if (!seenAt || firedAt > seenAt) fired += 1;
  }
  if (waiting === 0 && fired === 0) return EMPTY_CHAT_NOTE_BADGE;
  return { waiting, fired };
}

/** The newest fired time among this chat's notes, so marking it seen covers every one of them. */
export function latestNoteFiredAt(notes: readonly Note[], agentId: string): string | null {
  let latest: string | null = null;
  for (const note of notes) {
    if (note.anchor.kind !== "agent" || note.anchor.agentId !== agentId) continue;
    const firedAt = noteFiredAt(note);
    if (firedAt && (latest === null || firedAt > latest)) latest = firedAt;
  }
  return latest;
}
