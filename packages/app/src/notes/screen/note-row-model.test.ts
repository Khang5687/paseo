import { describe, expect, it } from "vitest";
import type { HostNote } from "@/notes/model";
import { buildNoteRowModel, describeTimeUntil, reminderDay } from "./note-row-model";

function hostNote(overrides: Partial<HostNote> = {}): HostNote {
  return {
    id: "n1",
    text: "Check the migration",
    quote: "ALTER TABLE users",
    anchor: { kind: "agent", agentId: "a1" },
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-01T10:00:00.000Z",
    serverId: "mac",
    serverName: "Mac",
    ...overrides,
  };
}

const titles: Record<string, string> = { "mac:a1": "Fix login", "mac:a2": "Run tests" };
const agentTitle = (serverId: string, agentId: string) => titles[`${serverId}:${agentId}`] ?? null;

describe("buildNoteRowModel", () => {
  it("shows the text with the quote under it and names the agent's thread", () => {
    const row = buildNoteRowModel({ note: hostNote(), agentTitle, singleHost: false });

    expect(row).toMatchObject({
      key: "mac:n1",
      title: "Check the migration",
      quote: "ALTER TABLE users",
      source: { kind: "agent", hostName: "Mac", name: "Fix login" },
      wait: null,
      status: { kind: "open" },
      resolved: false,
    });
  });

  it("falls back to the quote as the title when the note has no text", () => {
    const row = buildNoteRowModel({
      note: hostNote({ text: "  " }),
      agentTitle,
      singleHost: true,
    });

    expect(row.title).toBe("ALTER TABLE users");
    expect(row.quote).toBeNull();
    expect(row.source.hostName).toBeNull();
  });

  it("names a terminal source by its terminal name", () => {
    const row = buildNoteRowModel({
      note: hostNote({ anchor: { kind: "terminal", terminalId: "t1", terminalName: "zsh" } }),
      agentTitle,
      singleHost: false,
    });

    expect(row.source).toEqual({ kind: "terminal", hostName: "Mac", name: "zsh" });
  });

  it("describes an agent wait with the live title, then the stored one", () => {
    const live = buildNoteRowModel({
      note: hostNote({ wait: { type: "agent", agentId: "a2", agentTitle: "old" } }),
      agentTitle,
      singleHost: false,
    });
    const stored = buildNoteRowModel({
      note: hostNote({ wait: { type: "agent", agentId: "gone", agentTitle: "Deploy" } }),
      agentTitle,
      singleHost: false,
    });

    expect(live.status).toEqual({ kind: "waiting" });
    expect(live.wait).toEqual({ kind: "agent", agentName: "Run tests" });
    expect(stored.wait).toEqual({ kind: "agent", agentName: "Deploy" });
  });

  it("describes command and time waits", () => {
    const command = buildNoteRowModel({
      note: hostNote({
        wait: { type: "terminal-command", terminalId: "t1", condition: "success" },
      }),
      agentTitle,
      singleHost: false,
    });
    const time = buildNoteRowModel({
      note: hostNote({ wait: { type: "time", at: "2026-11-01T15:00:00.000Z" } }),
      agentTitle,
      singleHost: false,
    });

    expect(command.wait).toEqual({ kind: "command", condition: "success", command: null });
    expect(time.wait).toEqual({ kind: "time", at: new Date("2026-11-01T15:00:00.000Z") });
  });

  it("marks a note resolved by its event as fired, with the event's detail", () => {
    const row = buildNoteRowModel({
      note: hostNote({
        wait: { type: "terminal-command", terminalId: "t1", condition: "any" },
        waitResult: { at: "2026-11-01T11:00:00.000Z", matched: true, detail: "Exited with 0" },
        resolvedAt: "2026-11-01T11:00:00.000Z",
      }),
      agentTitle,
      singleHost: false,
    });

    expect(row.status).toEqual({ kind: "fired", detail: "Exited with 0" });
    expect(row.wait).toBeNull();
    expect(row.resolved).toBe(true);
  });

  it("marks a note resolved by hand as plainly resolved", () => {
    const row = buildNoteRowModel({
      note: hostNote({
        wait: { type: "agent", agentId: "a1" },
        resolvedAt: "2026-11-01T11:00:00.000Z",
      }),
      agentTitle,
      singleHost: false,
    });

    expect(row.status).toEqual({ kind: "resolved" });
  });

  it("keeps a note whose event missed its condition open, with the detail", () => {
    const row = buildNoteRowModel({
      note: hostNote({
        wait: { type: "terminal-command", terminalId: "t1", condition: "failure" },
        waitResult: { at: "2026-11-01T11:00:00.000Z", matched: false, detail: "Succeeded" },
      }),
      agentTitle,
      singleHost: false,
    });

    expect(row.status).toEqual({ kind: "unmatched", detail: "Succeeded" });
    expect(row.wait).toBeNull();
  });
});

describe("describeTimeUntil", () => {
  const now = new Date("2026-11-01T12:00:00.000Z");

  it("is null once the time has passed", () => {
    expect(describeTimeUntil(new Date("2026-11-01T11:59:00.000Z"), now)).toBeNull();
    expect(describeTimeUntil(now, now)).toBeNull();
  });

  it("rounds minutes up and hours and days down", () => {
    expect(describeTimeUntil(new Date("2026-11-01T12:00:20.000Z"), now)).toEqual({
      unit: "minute",
      count: 1,
    });
    expect(describeTimeUntil(new Date("2026-11-01T13:30:00.000Z"), now)).toEqual({
      unit: "hour",
      count: 1,
    });
    expect(describeTimeUntil(new Date("2026-11-04T13:00:00.000Z"), now)).toEqual({
      unit: "day",
      count: 3,
    });
  });
});

describe("reminderDay", () => {
  it("names today and tomorrow on the local calendar", () => {
    const now = new Date(2026, 10, 1, 23, 0);

    expect(reminderDay(new Date(2026, 10, 1, 23, 30), now)).toBe("today");
    expect(reminderDay(new Date(2026, 10, 2, 0, 30), now)).toBe("tomorrow");
    expect(reminderDay(new Date(2026, 10, 5, 9, 0), now)).toBe("other");
  });
});
