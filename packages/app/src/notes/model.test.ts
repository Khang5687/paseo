import { describe, expect, it } from "vitest";
import { applyNoteChange, filterNotes, mergeHostNotes, noteState, type Note } from "./model";

function note(overrides: Partial<Note> & { id: string }): Note {
  return {
    text: overrides.id,
    quote: "quoted",
    anchor: { kind: "agent", agentId: "agent-1" },
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-01T10:00:00.000Z",
    ...overrides,
  };
}

const waiting = (id: string, createdAt: string): Note =>
  note({ id, createdAt, wait: { type: "agent", agentId: "agent-1" }, waitResult: null });

describe("mergeHostNotes", () => {
  it("puts blockers from every host on top, then open notes, then resolved ones", () => {
    const merged = mergeHostNotes([
      {
        serverId: "mac",
        serverName: "Mac",
        notes: [
          note({ id: "mac-plain", createdAt: "2026-11-01T12:00:00.000Z" }),
          note({
            id: "mac-done",
            resolvedAt: "2026-11-01T13:00:00.000Z",
            wait: { type: "time", at: "2026-11-01T13:00:00.000Z" },
            waitResult: { at: "2026-11-01T13:00:00.000Z", matched: true },
          }),
          waiting("mac-blocker", "2026-11-01T09:00:00.000Z"),
        ],
      },
      {
        serverId: "omen",
        serverName: "Omen",
        notes: [
          waiting("omen-blocker", "2026-11-01T11:00:00.000Z"),
          note({ id: "omen-plain", createdAt: "2026-11-01T08:00:00.000Z" }),
        ],
      },
    ]);

    expect(merged.map((entry) => [entry.id, entry.serverName])).toEqual([
      ["omen-blocker", "Omen"],
      ["mac-blocker", "Mac"],
      ["mac-plain", "Mac"],
      ["omen-plain", "Omen"],
      ["mac-done", "Mac"],
    ]);
  });

  it("keeps notes with the same id on different hosts apart", () => {
    const merged = mergeHostNotes([
      { serverId: "a", serverName: "A", notes: [note({ id: "same" })] },
      { serverId: "b", serverName: "B", notes: [note({ id: "same" })] },
    ]);
    expect(merged.map((entry) => entry.serverId)).toEqual(["a", "b"]);
  });

  it("treats a waiting-on note whose event missed its condition as open", () => {
    const missed = note({
      id: "missed",
      wait: { type: "terminal-command", terminalId: "t", condition: "failure" },
      waitResult: { at: "2026-11-01T10:05:00.000Z", matched: false, exitCode: 0 },
    });
    expect(noteState(missed)).toBe("open");
    expect(filterNotes([missed, waiting("w", "2026-11-01T10:00:00.000Z")], "waiting")).toEqual([
      expect.objectContaining({ id: "w" }),
    ]);
  });
});

describe("applyNoteChange", () => {
  it("adds, replaces and removes notes", () => {
    const first = note({ id: "n1" });
    const added = applyNoteChange([], { kind: "upsert", note: first });
    const edited = applyNoteChange(added, {
      kind: "upsert",
      note: { ...first, text: "edited", updatedAt: "2026-11-01T11:00:00.000Z" },
    });
    expect(edited).toEqual([expect.objectContaining({ id: "n1", text: "edited" })]);
    expect(applyNoteChange(edited, { kind: "remove", noteId: "n1" })).toEqual([]);
  });

  it("ignores a change older than the note it would replace", () => {
    const current = note({ id: "n1", text: "new", updatedAt: "2026-11-01T11:00:00.000Z" });
    const stale = note({ id: "n1", text: "old", updatedAt: "2026-11-01T10:00:00.000Z" });
    expect(applyNoteChange([current], { kind: "upsert", note: stale })).toEqual([current]);
  });
});
