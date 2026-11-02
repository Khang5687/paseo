import type { NoteDraft } from "@/notes/composer-store";
import type { Note, NoteCommandCondition, NoteWait } from "@/notes/model";
import {
  parseReminderTime,
  resolveReminderPreset,
  type ReminderPreset,
} from "./parse-reminder-time";

/**
 * The note composer's form, as plain data. The sheet builds it once per open (`openCreateForm` /
 * `openEditForm`), applies the user's edits with spread updates, and asks this module what to
 * save. Nothing here reads React or the clock: callers pass `now`.
 */

export type NoteWaitKind = "agent" | "command" | "time";

/**
 * Where a time wait's instant comes from. Presets and typed text resolve against the clock at
 * save time, so "in 30 min" means 30 minutes after Save; `fixed` is an edited note's saved time.
 */
export type NoteTimeSource =
  | { kind: "none" }
  | { kind: "preset"; preset: ReminderPreset }
  | { kind: "text"; text: string }
  | { kind: "fixed"; at: string };

/** A picked agent or terminal with the label captured when it was picked. */
export interface NoteComposerPick {
  id: string;
  label: string | null;
}

export interface NoteComposerForm {
  text: string;
  /** False for a plain note; true when the note waits on `waitKind`. */
  waiting: boolean;
  waitKind: NoteWaitKind;
  agent: NoteComposerPick | null;
  terminal: NoteComposerPick | null;
  condition: NoteCommandCondition;
  /** Optional label for the awaited command. */
  command: string;
  time: NoteTimeSource;
}

export function openCreateForm(
  draft: NoteDraft,
  agentTitle: (agentId: string) => string | null,
): NoteComposerForm {
  const { anchor, agentId, terminalId } = draft;
  let waitKind: NoteWaitKind = "time";
  if (terminalId) waitKind = "command";
  else if (agentId) waitKind = "agent";
  const terminalName =
    anchor.kind === "terminal" && anchor.terminalId === terminalId
      ? (anchor.terminalName ?? null)
      : null;
  return {
    text: "",
    waiting: false,
    waitKind,
    agent: agentId ? { id: agentId, label: agentTitle(agentId) } : null,
    terminal: terminalId ? { id: terminalId, label: terminalName } : null,
    condition: "any",
    command: draft.command?.trim() ?? "",
    time: { kind: "none" },
  };
}

export function openEditForm(note: Note): NoteComposerForm {
  const wait = note.wait ?? null;
  const anchorAgentId = note.anchor.kind === "agent" ? note.anchor.agentId : null;
  const anchorTerminal =
    note.anchor.kind === "terminal"
      ? { id: note.anchor.terminalId, label: note.anchor.terminalName ?? null }
      : null;
  const base: NoteComposerForm = {
    text: note.text,
    waiting: wait !== null,
    waitKind: anchorTerminal ? "command" : "agent",
    agent: anchorAgentId ? { id: anchorAgentId, label: null } : null,
    terminal: anchorTerminal,
    condition: "any",
    command: "",
    time: { kind: "none" },
  };
  if (!wait) return base;
  switch (wait.type) {
    case "agent":
      return {
        ...base,
        waitKind: "agent",
        agent: { id: wait.agentId, label: wait.agentTitle ?? null },
      };
    case "terminal-command":
      return {
        ...base,
        waitKind: "command",
        terminal: {
          id: wait.terminalId,
          label: anchorTerminal?.id === wait.terminalId ? anchorTerminal.label : null,
        },
        condition: wait.condition,
        command: wait.command ?? "",
      };
    case "time":
      return { ...base, waitKind: "time", time: { kind: "fixed", at: wait.at } };
  }
}

/** The instant a time wait resolves to now; null while nothing readable is chosen. */
export function resolveFormTime(time: NoteTimeSource, now: Date): Date | null {
  switch (time.kind) {
    case "none":
      return null;
    case "preset":
      return resolveReminderPreset(time.preset, now);
    case "text":
      return parseReminderTime(time.text, now);
    case "fixed": {
      const at = new Date(time.at);
      return Number.isNaN(at.getTime()) ? null : at;
    }
  }
}

export type FormWaitResult = { ok: true; wait: NoteWait | null } | { ok: false };

/** The wait the form describes, or `ok: false` while a waiting-on choice is incomplete. */
export function buildFormWait(form: NoteComposerForm, now: Date): FormWaitResult {
  if (!form.waiting) return { ok: true, wait: null };
  switch (form.waitKind) {
    case "agent": {
      if (!form.agent) return { ok: false };
      const title = form.agent.label?.trim();
      return {
        ok: true,
        wait: { type: "agent", agentId: form.agent.id, ...(title ? { agentTitle: title } : {}) },
      };
    }
    case "command": {
      if (!form.terminal) return { ok: false };
      const command = form.command.trim();
      return {
        ok: true,
        wait: {
          type: "terminal-command",
          terminalId: form.terminal.id,
          condition: form.condition,
          ...(command ? { command } : {}),
        },
      };
    }
    case "time": {
      const at = resolveFormTime(form.time, now);
      if (!at) return { ok: false };
      return { ok: true, wait: { type: "time", at: at.toISOString() } };
    }
  }
}

export function canSaveForm(form: NoteComposerForm, now: Date): boolean {
  return form.text.trim().length > 0 && buildFormWait(form, now).ok;
}

export function sameWait(a: NoteWait | null | undefined, b: NoteWait | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  switch (a.type) {
    case "agent":
      return b.type === "agent" && a.agentId === b.agentId;
    case "terminal-command":
      return (
        b.type === "terminal-command" &&
        a.terminalId === b.terminalId &&
        a.condition === b.condition &&
        (a.command ?? "") === (b.command ?? "")
      );
    case "time":
      return b.type === "time" && new Date(a.at).getTime() === new Date(b.at).getTime();
  }
}

/**
 * What an edit sends: only the fields that changed. `wait` is present only when it changed, so an
 * untouched waiting note keeps its watcher (and a fired note keeps its result).
 */
export function buildEditChanges(
  note: Note,
  form: NoteComposerForm,
  now: Date,
): { text?: string; wait?: NoteWait | null } | null {
  const built = buildFormWait(form, now);
  if (!built.ok) return null;
  const text = form.text.trim();
  return {
    ...(text !== note.text ? { text } : {}),
    ...(sameWait(note.wait, built.wait) ? {} : { wait: built.wait }),
  };
}
