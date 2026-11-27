import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type pino from "pino";
import { z } from "zod";
import {
  NoteSchema,
  type Note,
  type NoteAnchor,
  type NoteLocalReminder,
  type NoteWait,
  type NoteWaitResult,
} from "@getpaseo/protocol/notes/schemas";
import { writeFileAtomic } from "../atomic-file.js";

export type NoteChange = { kind: "upsert"; note: Note } | { kind: "remove"; noteId: string };

export interface NoteFiredEvent {
  note: Note;
  title: string;
  body: string;
  // False when a phone already alerts for this note with its own local notification.
  push: boolean;
}

export interface NotesServiceOptions {
  paseoHome: string;
  logger: pino.Logger;
  onFired?: (event: NoteFiredEvent) => void;
}

export interface CreateNoteInput {
  text: string;
  quote: string;
  anchor: NoteAnchor;
  wait?: NoteWait | null;
  localReminder?: NoteLocalReminder | null;
}

export interface EditNoteInput {
  noteId: string;
  text?: string;
  wait?: NoteWait | null;
  localReminder?: NoteLocalReminder | null;
  resolved?: boolean;
}

export type AgentAttentionReason = "finished" | "error" | "permission";

// setTimeout stores delays as a signed 32-bit int; longer delays fire immediately.
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const TITLE_LIMIT = 120;

const NotesFileSchema = z.object({ notes: z.array(z.unknown()) });

/**
 * Notes on highlighted chat text and terminal lines, persisted in `$PASEO_HOME/notes.json`.
 * A waiting-on note is armed until its event happens or the owner resolves it; the host fires it
 * once, records the result, and reports it through `onFired`.
 */
export class NotesService {
  private readonly filePath: string;
  private readonly logger: pino.Logger;
  private onFired: (event: NoteFiredEvent) => void;
  private readonly notes = new Map<string, Note>();
  private readonly listeners = new Set<(change: NoteChange) => void>();
  private writeChain: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  constructor(options: NotesServiceOptions) {
    this.filePath = path.join(options.paseoHome, "notes.json");
    this.logger = options.logger.child({ module: "notes" });
    this.onFired = options.onFired ?? (() => {});
  }

  // The websocket server delivers fired notes; it is created after this service.
  setFiredHandler(handler: (event: NoteFiredEvent) => void): void {
    this.onFired = handler;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    for (const note of await this.load()) this.notes.set(note.id, note);
    this.armTimer();
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.writeChain;
  }

  list(): Note[] {
    return [...this.notes.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  subscribe(listener: (change: NoteChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async create(input: CreateNoteInput): Promise<Note> {
    const now = new Date().toISOString();
    const note = NoteSchema.parse({
      id: `note_${randomUUID().replaceAll("-", "")}`,
      text: input.text.trim(),
      quote: input.quote,
      anchor: input.anchor,
      wait: input.wait ?? null,
      waitResult: null,
      localReminder: input.wait?.type === "time" ? (input.localReminder ?? null) : null,
      resolvedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    assertValidWait(note.wait);
    await this.commit(note);
    return note;
  }

  async edit(input: EditNoteInput): Promise<Note> {
    const current = this.require(input.noteId);
    const next: Note = { ...current, updatedAt: new Date().toISOString() };
    if (input.text !== undefined) next.text = input.text.trim();
    if (input.wait !== undefined && !sameWait(input.wait, current.wait ?? null)) {
      assertValidWait(input.wait);
      next.wait = input.wait;
      next.waitResult = null;
      next.resolvedAt = null;
      // A reminder moved by another device is no longer covered by the phone's local alert.
      next.localReminder = null;
    }
    if (input.localReminder !== undefined) next.localReminder = input.localReminder;
    if (input.resolved !== undefined) {
      next.resolvedAt = input.resolved ? (current.resolvedAt ?? next.updatedAt) : null;
    }
    await this.commit(next);
    return next;
  }

  async delete(noteId: string): Promise<void> {
    this.require(noteId);
    this.notes.delete(noteId);
    await this.persist();
    this.armTimer();
    this.publish({ kind: "remove", noteId });
  }

  handleAgentAttention(input: { agentId: string; reason: AgentAttentionReason }): void {
    for (const note of this.armed()) {
      if (note.wait?.type !== "agent" || note.wait.agentId !== input.agentId) continue;
      void this.fire(note, { matched: true, detail: agentAttentionDetail(input.reason) });
    }
  }

  handleCommandFinished(input: { terminalId: string; exitCode: number | null }): void {
    for (const note of this.armed()) {
      const wait = note.wait;
      if (wait?.type !== "terminal-command" || wait.terminalId !== input.terminalId) continue;
      const succeeded = input.exitCode === 0;
      const matched =
        wait.condition === "any" ||
        (wait.condition === "success" && succeeded) ||
        (wait.condition === "failure" && !succeeded);
      void this.fire(note, {
        matched,
        exitCode: input.exitCode,
        detail: commandDetail(wait.command, input.exitCode),
      });
    }
  }

  private armed(): Note[] {
    return [...this.notes.values()].filter(isArmed);
  }

  private async fire(note: Note, result: Omit<NoteWaitResult, "at">): Promise<void> {
    const current = this.notes.get(note.id);
    // Already resolved (the owner acknowledged a phone reminder) or fired by an earlier event.
    if (!current || !isArmed(current)) return;
    const at = new Date().toISOString();
    const next: Note = {
      ...current,
      waitResult: { at, ...result },
      resolvedAt: result.matched ? at : null,
      updatedAt: at,
    };
    try {
      await this.commit(next);
    } catch (error) {
      this.logger.warn({ err: error, noteId: note.id }, "Failed to persist fired note");
      return;
    }
    if (!result.matched) return;
    const wait = current.wait;
    const phoneAlerts =
      wait?.type === "time" &&
      current.localReminder != null &&
      current.localReminder.at === wait.at;
    try {
      this.onFired({
        note: next,
        title: `Done: ${truncate(next.text || next.quote, TITLE_LIMIT)}`,
        body: result.detail ?? "",
        push: !phoneAlerts,
      });
    } catch (error) {
      this.logger.warn({ err: error, noteId: note.id }, "Note fired handler failed");
    }
  }

  private armTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.started) return;
    let nextAt = Number.POSITIVE_INFINITY;
    for (const note of this.armed()) {
      if (note.wait?.type !== "time") continue;
      nextAt = Math.min(nextAt, Date.parse(note.wait.at));
    }
    if (!Number.isFinite(nextAt)) return;
    const delay = Math.min(Math.max(0, nextAt - Date.now()), MAX_TIMER_DELAY_MS);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.fireDueTimes();
    }, delay);
    this.timer.unref?.();
  }

  private async fireDueTimes(): Promise<void> {
    const now = Date.now();
    const due = this.armed().filter(
      (note) => note.wait?.type === "time" && Date.parse(note.wait.at) <= now,
    );
    for (const note of due) await this.fire(note, { matched: true, detail: "Reminder" });
    this.armTimer();
  }

  private require(noteId: string): Note {
    const note = this.notes.get(noteId);
    if (!note) throw new Error(`Note not found: ${noteId}`);
    return note;
  }

  private async commit(note: Note): Promise<void> {
    const previous = this.notes.get(note.id);
    this.notes.set(note.id, note);
    try {
      await this.persist();
    } catch (error) {
      if (previous) this.notes.set(note.id, previous);
      else this.notes.delete(note.id);
      throw error;
    }
    this.armTimer();
    this.publish({ kind: "upsert", note });
  }

  private publish(change: NoteChange): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(change);
      } catch (error) {
        this.logger.warn({ err: error }, "Note change listener failed");
      }
    }
  }

  private persist(): Promise<void> {
    const write = this.writeChain.then(() =>
      writeFileAtomic(this.filePath, `${JSON.stringify({ notes: this.list() }, null, 2)}\n`),
    );
    this.writeChain = write.catch(() => {});
    return write;
  }

  private async load(): Promise<Note[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const file = NotesFileSchema.safeParse(JSON.parse(raw));
    if (!file.success) {
      this.logger.warn({ filePath: this.filePath }, "Ignoring unreadable notes file");
      return [];
    }
    const notes: Note[] = [];
    for (const entry of file.data.notes) {
      const parsed = NoteSchema.safeParse(entry);
      if (parsed.success) notes.push(parsed.data);
      else this.logger.warn({ issues: parsed.error.issues }, "Skipping invalid note");
    }
    return notes;
  }
}

function isArmed(note: Note): boolean {
  return note.wait != null && note.waitResult == null && note.resolvedAt == null;
}

function assertValidWait(wait: NoteWait | null | undefined): void {
  if (wait?.type === "time" && Number.isNaN(Date.parse(wait.at))) {
    throw new Error(`Invalid reminder time: ${wait.at}`);
  }
}

function sameWait(a: NoteWait | null, b: NoteWait | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function agentAttentionDetail(reason: AgentAttentionReason): string {
  if (reason === "permission") return "Agent needs input";
  if (reason === "error") return "Agent stopped with an error";
  return "Agent finished";
}

function commandDetail(command: string | undefined, exitCode: number | null): string {
  let outcome = `Command failed (exit ${exitCode})`;
  if (exitCode === 0) outcome = "Command succeeded";
  else if (exitCode === null) outcome = "Command finished";
  return command ? `${outcome}: ${truncate(command, TITLE_LIMIT)}` : outcome;
}

function truncate(text: string, limit: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1).trimEnd()}…`;
}
