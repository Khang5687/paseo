import { describe, expect, it } from "vitest";
import type { Note } from "@/notes/model";
import { createNotificationOpenRouter, parseNotificationOpenTarget } from "./model";
import type { NotificationOpenSource, NotificationTap } from "./source";

class FakeSource implements NotificationOpenSource {
  listeners = new Set<(tap: NotificationTap) => void>();
  acknowledged: string[] = [];
  launchReads = 0;
  constructor(readonly launch: NotificationTap | null) {}
  subscribe(onTap: (tap: NotificationTap) => void) {
    this.listeners.add(onTap);
    return () => {
      this.listeners.delete(onTap);
    };
  }
  async takeLaunchTap() {
    this.launchReads++;
    return this.launch;
  }
  acknowledge(tap: NotificationTap) {
    this.acknowledged.push(tap.id);
  }
  tap(tap: NotificationTap) {
    for (const listener of this.listeners) listener(tap);
  }
}
const launch: NotificationTap = {
  id: "one",
  data: { serverId: "host", workspaceId: "stale", agentId: "agent" },
};
async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("notification open", () => {
  it.each([
    [undefined, null],
    [null, null],
    [[], null],
    [{ agentId: "a" }, null],
    [{ serverId: " " }, null],
    [{ serverId: " h " }, { kind: "host", serverId: "h" }],
    [
      { serverId: "h", agentId: "a" },
      { kind: "agent", serverId: "h", agentId: "a" },
    ],
    [
      { serverId: "h", workspaceId: "stale", agentId: "a" },
      { kind: "agent", serverId: "h", agentId: "a" },
    ],
    [
      { serverId: "h", workspaceId: "w", terminalId: "t", agentId: "a" },
      { kind: "terminal", serverId: "h", workspaceId: "w", terminalId: "t" },
    ],
    [
      { serverId: "h", noteId: " n ", agentId: "a", workspaceId: "w" },
      {
        kind: "note",
        serverId: "h",
        noteId: "n",
        fallback: { kind: "agent", serverId: "h", agentId: "a" },
      },
    ],
    [
      { serverId: "h", noteId: "n", terminalId: "t", workspaceId: "w", cwd: "/repo" },
      {
        kind: "note",
        serverId: "h",
        noteId: "n",
        fallback: { kind: "terminal", serverId: "h", workspaceId: "w", terminalId: "t" },
      },
    ],
    [
      { serverId: "h", noteId: "n", terminalId: "t" },
      { kind: "note", serverId: "h", noteId: "n", fallback: { kind: "host", serverId: "h" } },
    ],
    [
      { serverId: "h", noteId: " ", agentId: "a" },
      { kind: "agent", serverId: "h", agentId: "a" },
    ],
  ])("parses %j", (data, expected) => {
    expect(parseNotificationOpenTarget(data)).toEqual(expected);
  });

  function setup(
    whenReadyToNavigate = () => Promise.resolve(),
    notes: { serverId: string; note: Note }[] = [],
    canOpenNote = true,
  ) {
    const source = new FakeSource(launch);
    const agents: unknown[] = [];
    const routes: string[] = [];
    const terminals: unknown[] = [];
    const openedNotes: { serverId: string; noteId: string }[] = [];
    const router = createNotificationOpenRouter({
      source,
      openAgent: (target) => {
        agents.push(target);
      },
      openTerminal: (target) => {
        terminals.push(target);
      },
      openRoute: (route) => {
        routes.push(route);
      },
      resolveNote: async ({ serverId, noteId }) => {
        if (noteId === "throws") throw new Error("host unreachable");
        return (
          notes.find((entry) => entry.serverId === serverId && entry.note.id === noteId)?.note ??
          null
        );
      },
      openNote: (serverId, note) => {
        if (canOpenNote) openedNotes.push({ serverId, noteId: note.id });
        return canOpenNote;
      },
      whenReadyToNavigate,
    });
    return { source, agents, routes, terminals, openedNotes, router };
  }

  it("takes the launch tap once across remounts", async () => {
    const { source, agents, router } = setup();
    router.start()();
    const stop = router.start();
    await flush();
    expect(source.launchReads).toBe(1);
    expect(agents).toEqual([{ serverId: "host", agentId: "agent" }]);
    stop();
  });

  it("ignores listener replay of the launch tap after remount", async () => {
    const { source, agents, router } = setup();
    const stop = router.start();
    await flush();
    stop();
    const stopAgain = router.start();
    source.tap(launch);
    await flush();
    expect(agents).toEqual([{ serverId: "host", agentId: "agent" }]);
    expect(source.acknowledged).toEqual(["one"]);
    stopAgain();
  });

  it("waits for readiness before dispatch and acknowledgement", async () => {
    let ready = () => {};
    const readiness = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const { source, agents, router } = setup(() => readiness);
    const stop = router.start();
    await flush();
    expect(agents).toEqual([]);
    expect(source.acknowledged).toEqual([]);
    ready();
    await flush();
    expect(agents).toEqual([{ serverId: "host", agentId: "agent" }]);
    expect(source.acknowledged).toEqual(["one"]);
    stop();
  });

  it("acknowledges each distinct tap including invalid targets", async () => {
    const { source, agents, router } = setup();
    const stop = router.start();
    await flush();
    source.tap({ id: "two", data: { serverId: "host", agentId: "second" } });
    source.tap({ id: "invalid", data: undefined });
    await flush();
    expect(agents).toEqual([
      { serverId: "host", agentId: "agent" },
      { serverId: "host", agentId: "second" },
    ]);
    expect(source.acknowledged).toEqual(["one", "two", "invalid"]);
    stop();
  });

  it("dispatches terminals and hosts through their navigation capabilities", async () => {
    const { source, routes, terminals, router } = setup();
    const stop = router.start();
    source.tap({
      id: "terminal",
      data: { serverId: "host", workspaceId: "ws", terminalId: "term" },
    });
    source.tap({ id: "host", data: { serverId: "host" } });
    await flush();
    expect(routes).toEqual(["/h/host"]);
    expect(terminals).toEqual([
      { kind: "terminal", serverId: "host", workspaceId: "ws", terminalId: "term" },
    ]);
    stop();
  });

  const savedNote: Note = {
    id: "note-1",
    text: "check the build",
    quote: "npm run build",
    anchor: { kind: "agent", agentId: "agent", workspaceId: "ws" },
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  };

  it("opens a tapped note at its highlighted spot", async () => {
    const { source, agents, openedNotes, router } = setup(undefined, [
      { serverId: "host", note: savedNote },
    ]);
    const stop = router.start();
    await flush();
    source.tap({
      id: "note",
      data: { serverId: "host", noteId: "note-1", agentId: "agent", workspaceId: "ws" },
    });
    await flush();
    expect(openedNotes).toEqual([{ serverId: "host", noteId: "note-1" }]);
    expect(agents).toEqual([{ serverId: "host", agentId: "agent" }]);
    expect(source.acknowledged).toEqual(["one", "note"]);
    stop();
  });

  it("falls back to the note's chat or terminal when the note cannot be found or opened", async () => {
    const missing = setup();
    const stopMissing = missing.router.start();
    await flush();
    missing.source.tap({
      id: "gone",
      data: { serverId: "host", noteId: "deleted", workspaceId: "ws", terminalId: "term" },
    });
    missing.source.tap({
      id: "offline",
      data: { serverId: "host", noteId: "throws", agentId: "a2" },
    });
    await flush();
    expect(missing.openedNotes).toEqual([]);
    expect(missing.terminals).toEqual([
      { kind: "terminal", serverId: "host", workspaceId: "ws", terminalId: "term" },
    ]);
    expect(missing.agents).toEqual([
      { serverId: "host", agentId: "agent" },
      { serverId: "host", agentId: "a2" },
    ]);
    expect(missing.source.acknowledged).toEqual(["one", "gone", "offline"]);
    stopMissing();

    const unopenable = setup(undefined, [{ serverId: "host", note: savedNote }], false);
    const stopUnopenable = unopenable.router.start();
    await flush();
    unopenable.source.tap({ id: "note", data: { serverId: "host", noteId: "note-1" } });
    await flush();
    expect(unopenable.routes).toEqual(["/h/host"]);
    stopUnopenable();
  });
});
