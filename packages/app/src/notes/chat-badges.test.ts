import { describe, expect, it } from "vitest";
import { chatNoteBadge, chatNotesKey, latestNoteFiredAt, type ChatNotesSeen } from "./chat-badges";
import type { Note } from "./model";

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

const waiting = (id: string, agentId = "agent-1"): Note =>
  note({ id, anchor: { kind: "agent", agentId }, wait: { type: "agent", agentId } });

const fired = (id: string, at: string, agentId = "agent-1"): Note =>
  note({
    id,
    anchor: { kind: "agent", agentId },
    wait: { type: "agent", agentId },
    waitResult: { at, matched: true },
    resolvedAt: at,
  });

const NEVER_SEEN: ChatNotesSeen = { since: "2026-11-01T00:00:00.000Z", seenAt: {} };

describe("chatNoteBadge", () => {
  it("counts waiting notes on the row's chats only", () => {
    const badge = chatNoteBadge({
      serverId: "mac",
      agentIds: ["agent-1", "agent-2"],
      notes: [
        waiting("a"),
        waiting("b", "agent-2"),
        waiting("elsewhere", "agent-9"),
        note({ id: "plain" }),
      ],
      seen: NEVER_SEEN,
    });
    expect(badge).toEqual({ waiting: 2, fired: 0 });
  });

  it("shows a fired note until its chat is opened after it fired", () => {
    const notes = [fired("f", "2026-11-01T12:00:00.000Z")];
    const input = { serverId: "mac", agentIds: ["agent-1"], notes };
    expect(chatNoteBadge({ ...input, seen: NEVER_SEEN })).toEqual({ waiting: 0, fired: 1 });

    const seenBefore: ChatNotesSeen = {
      ...NEVER_SEEN,
      seenAt: { [chatNotesKey("mac", "agent-1")]: "2026-11-01T11:00:00.000Z" },
    };
    expect(chatNoteBadge({ ...input, seen: seenBefore })).toEqual({ waiting: 0, fired: 1 });

    const seenAfter: ChatNotesSeen = {
      ...NEVER_SEEN,
      seenAt: { [chatNotesKey("mac", "agent-1")]: "2026-11-01T12:00:00.000Z" },
    };
    expect(chatNoteBadge({ ...input, seen: seenAfter })).toEqual({ waiting: 0, fired: 0 });
  });

  it("does not badge notes fired before this device started tracking", () => {
    const badge = chatNoteBadge({
      serverId: "mac",
      agentIds: ["agent-1"],
      notes: [fired("old", "2026-10-30T12:00:00.000Z")],
      seen: NEVER_SEEN,
    });
    expect(badge).toEqual({ waiting: 0, fired: 0 });
  });

  it("never badges a note resolved by hand or one whose event missed its condition", () => {
    const badge = chatNoteBadge({
      serverId: "mac",
      agentIds: ["agent-1"],
      notes: [
        note({ id: "by-hand", resolvedAt: "2026-11-01T12:00:00.000Z" }),
        note({
          id: "missed",
          wait: { type: "agent", agentId: "agent-1" },
          waitResult: { at: "2026-11-01T12:00:00.000Z", matched: false },
        }),
        note({
          id: "terminal",
          anchor: { kind: "terminal", terminalId: "t-1" },
          wait: { type: "terminal-command", terminalId: "t-1", condition: "any" },
        }),
      ],
      seen: NEVER_SEEN,
    });
    expect(badge).toEqual({ waiting: 0, fired: 0 });
  });

  it("keeps a chat seen on one host from clearing the same agent id on another host", () => {
    const notes = [fired("f", "2026-11-01T12:00:00.000Z")];
    const seen: ChatNotesSeen = {
      ...NEVER_SEEN,
      seenAt: { [chatNotesKey("mac", "agent-1")]: "2026-11-01T13:00:00.000Z" },
    };
    expect(chatNoteBadge({ serverId: "mac", agentIds: ["agent-1"], notes, seen }).fired).toBe(0);
    expect(chatNoteBadge({ serverId: "omen", agentIds: ["agent-1"], notes, seen }).fired).toBe(1);
  });
});

describe("latestNoteFiredAt", () => {
  it("covers every fired note of the chat, ignoring other chats", () => {
    const notes = [
      fired("early", "2026-11-01T12:00:00.000Z"),
      fired("late", "2026-11-01T14:00:00.000Z"),
      fired("other", "2026-11-01T15:00:00.000Z", "agent-2"),
      waiting("w"),
    ];
    expect(latestNoteFiredAt(notes, "agent-1")).toBe("2026-11-01T14:00:00.000Z");
    expect(latestNoteFiredAt([waiting("w")], "agent-1")).toBeNull();
  });
});
