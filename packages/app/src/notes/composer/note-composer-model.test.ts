import { describe, expect, it } from "vitest";
import type { NoteDraft } from "@/notes/composer-store";
import type { Note } from "@/notes/model";
import {
  buildEditChanges,
  buildFormWait,
  canSaveForm,
  openCreateForm,
  openEditForm,
  type NoteComposerForm,
} from "./note-composer-model";

const NOW = new Date(2026, 5, 10, 14, 0, 0, 0);

const agentDraft: NoteDraft = {
  serverId: "host",
  quote: "Run the migration",
  anchor: { kind: "agent", agentId: "agent-1", role: "assistant" },
  agentId: "agent-1",
};

const terminalDraft: NoteDraft = {
  serverId: "host",
  quote: "$ npm test",
  anchor: { kind: "terminal", terminalId: "term-1", terminalName: "zsh" },
  terminalId: "term-1",
  command: " npm test ",
};

function note(overrides: Partial<Note> = {}): Note {
  return {
    id: "note-1",
    text: "Check the result",
    quote: "quoted",
    anchor: { kind: "terminal", terminalId: "term-1", terminalName: "zsh" },
    createdAt: "2026-06-10T10:00:00.000Z",
    updatedAt: "2026-06-10T10:00:00.000Z",
    ...overrides,
  };
}

function titles(agentId: string): string | null {
  return agentId === "agent-1" ? "Migrations" : null;
}

describe("openCreateForm", () => {
  it("starts as a plain note waiting on the thread's agent by default", () => {
    const form = openCreateForm(agentDraft, titles);
    expect(form.waiting).toBe(false);
    expect(form.waitKind).toBe("agent");
    expect(form.agent).toEqual({ id: "agent-1", label: "Migrations" });
  });

  it("defaults a terminal selection to its command", () => {
    const form = openCreateForm(terminalDraft, titles);
    expect(form.waitKind).toBe("command");
    expect(form.terminal).toEqual({ id: "term-1", label: "zsh" });
    expect(form.command).toBe("npm test");
  });

  it("defaults to a time when the draft has no agent or terminal", () => {
    const form = openCreateForm({ ...agentDraft, agentId: undefined }, titles);
    expect(form.waitKind).toBe("time");
    expect(form.agent).toBeNull();
  });
});

describe("buildFormWait", () => {
  const base = openCreateForm(terminalDraft, titles);

  it("is null for a plain note", () => {
    expect(buildFormWait(base, NOW)).toEqual({ ok: true, wait: null });
  });

  it("builds a command wait with its condition and label", () => {
    const form: NoteComposerForm = { ...base, waiting: true, condition: "failure" };
    expect(buildFormWait(form, NOW)).toEqual({
      ok: true,
      wait: {
        type: "terminal-command",
        terminalId: "term-1",
        condition: "failure",
        command: "npm test",
      },
    });
  });

  it("builds an agent wait with the picked agent's title", () => {
    const form: NoteComposerForm = {
      ...openCreateForm(agentDraft, titles),
      waiting: true,
    };
    expect(buildFormWait(form, NOW)).toEqual({
      ok: true,
      wait: { type: "agent", agentId: "agent-1", agentTitle: "Migrations" },
    });
  });

  it("resolves a preset from the save time", () => {
    const form: NoteComposerForm = {
      ...base,
      waiting: true,
      waitKind: "time",
      time: { kind: "preset", preset: "in30m" },
    };
    expect(buildFormWait(form, NOW)).toEqual({
      ok: true,
      wait: { type: "time", at: new Date(NOW.getTime() + 30 * 60_000).toISOString() },
    });
  });

  it("is incomplete until a time is readable", () => {
    const form: NoteComposerForm = {
      ...base,
      text: "Ping",
      waiting: true,
      waitKind: "time",
      time: { kind: "text", text: "soon" },
    };
    expect(buildFormWait(form, NOW)).toEqual({ ok: false });
    expect(canSaveForm(form, NOW)).toBe(false);
    expect(canSaveForm({ ...form, time: { kind: "text", text: "3pm" } }, NOW)).toBe(true);
  });

  it("is incomplete without a picked agent", () => {
    const form: NoteComposerForm = { ...base, waiting: true, waitKind: "agent", agent: null };
    expect(buildFormWait(form, NOW)).toEqual({ ok: false });
  });
});

describe("canSaveForm", () => {
  it("needs note text", () => {
    const form = openCreateForm(agentDraft, titles);
    expect(canSaveForm(form, NOW)).toBe(false);
    expect(canSaveForm({ ...form, text: "  " }, NOW)).toBe(false);
    expect(canSaveForm({ ...form, text: "Follow up" }, NOW)).toBe(true);
  });
});

describe("edit", () => {
  const timeNote = note({ wait: { type: "time", at: "2026-06-10T18:00:00.000Z" } });

  it("seeds the form from the note's wait", () => {
    const form = openEditForm(
      note({ wait: { type: "terminal-command", terminalId: "term-1", condition: "success" } }),
    );
    expect(form).toMatchObject({
      text: "Check the result",
      waiting: true,
      waitKind: "command",
      terminal: { id: "term-1", label: "zsh" },
      condition: "success",
    });
  });

  it("sends nothing when nothing changed, keeping a past saved time", () => {
    const form = openEditForm(timeNote);
    expect(buildEditChanges(timeNote, form, new Date("2026-06-11T00:00:00.000Z"))).toEqual({});
  });

  it("sends only the changed text", () => {
    const form = { ...openEditForm(timeNote), text: "New text " };
    expect(buildEditChanges(timeNote, form, NOW)).toEqual({ text: "New text" });
  });

  it("sends a cleared wait when the note becomes plain", () => {
    const form = { ...openEditForm(timeNote), waiting: false };
    expect(buildEditChanges(timeNote, form, NOW)).toEqual({ wait: null });
  });

  it("sends a new time", () => {
    const form: NoteComposerForm = {
      ...openEditForm(timeNote),
      time: { kind: "preset", preset: "in1h" },
    };
    expect(buildEditChanges(timeNote, form, NOW)).toEqual({
      wait: { type: "time", at: new Date(NOW.getTime() + 60 * 60_000).toISOString() },
    });
  });

  it("returns null while the form is incomplete", () => {
    const form: NoteComposerForm = { ...openEditForm(timeNote), time: { kind: "none" } };
    expect(buildEditChanges(timeNote, form, NOW)).toBeNull();
  });
});
