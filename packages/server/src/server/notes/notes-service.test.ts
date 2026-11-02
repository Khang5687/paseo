import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { NotesService, type NoteFiredEvent } from "./notes-service.js";

const agentAnchor = { kind: "agent" as const, agentId: "agent-1", rowId: "row-1" };
const terminalAnchor = { kind: "terminal" as const, terminalId: "term-1", startLine: 3 };

describe("NotesService", () => {
  let paseoHome: string;
  let fired: NoteFiredEvent[];
  let services: NotesService[];

  function createService(): NotesService {
    const service = new NotesService({
      paseoHome,
      logger: createTestLogger(),
      onFired: (event) => fired.push(event),
    });
    services.push(service);
    return service;
  }

  beforeEach(async () => {
    paseoHome = await mkdtemp(join(tmpdir(), "notes-service-test-"));
    fired = [];
    services = [];
  });

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(services.map((service) => service.stop()));
    await rm(paseoHome, { recursive: true, force: true });
  });

  test("persists notes and their state across restarts", async () => {
    const service = createService();
    await service.start();
    const note = await service.create({
      text: "  check this claim ",
      quote: "The cache is never invalidated",
      anchor: agentAnchor,
    });
    await service.edit({ noteId: note.id, resolved: true });

    const reloaded = createService();
    await reloaded.start();
    const [restored] = reloaded.list();
    expect(restored).toMatchObject({
      id: note.id,
      text: "check this claim",
      quote: "The cache is never invalidated",
      anchor: agentAnchor,
    });
    expect(restored.resolvedAt).toEqual(expect.any(String));

    await reloaded.delete(note.id);
    const empty = createService();
    await empty.start();
    expect(empty.list()).toEqual([]);
  });

  test("publishes upserts and removals to subscribers", async () => {
    const service = createService();
    await service.start();
    const changes: string[] = [];
    service.subscribe((change) => changes.push(change.kind));
    const note = await service.create({ text: "a", quote: "b", anchor: agentAnchor });
    await service.delete(note.id);
    expect(changes).toEqual(["upsert", "remove"]);
  });

  test("fires an agent note once when that agent finishes or needs input", async () => {
    const service = createService();
    await service.start();
    const note = await service.create({
      text: "review the plan",
      quote: "plan",
      anchor: agentAnchor,
      wait: { type: "agent", agentId: "agent-2" },
    });

    service.handleAgentAttention({ agentId: "agent-1", reason: "finished" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fired).toEqual([]);

    service.handleAgentAttention({ agentId: "agent-2", reason: "permission" });
    await vi.waitFor(() => expect(fired).toHaveLength(1));
    expect(fired[0]).toMatchObject({
      title: "Done: review the plan",
      body: "Agent needs input",
      push: true,
    });
    const [resolved] = service.list();
    expect(resolved.id).toBe(note.id);
    expect(resolved.waitResult).toMatchObject({ matched: true });
    expect(resolved.resolvedAt).toEqual(expect.any(String));

    service.handleAgentAttention({ agentId: "agent-2", reason: "finished" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fired).toHaveLength(1);
  });

  test("fires a terminal note only when the command outcome matches", async () => {
    const service = createService();
    await service.start();
    const onFailure = await service.create({
      text: "tests broke",
      quote: "$ npm test",
      anchor: terminalAnchor,
      wait: { type: "terminal-command", terminalId: "term-1", condition: "failure" },
    });
    const onSuccess = await service.create({
      text: "deploy done",
      quote: "$ npm run deploy",
      anchor: { ...terminalAnchor, terminalId: "term-2" },
      wait: {
        type: "terminal-command",
        terminalId: "term-2",
        condition: "success",
        command: "npm run deploy",
      },
    });

    service.handleCommandFinished({ terminalId: "term-1", exitCode: 0 });
    service.handleCommandFinished({ terminalId: "term-2", exitCode: 0 });
    await vi.waitFor(() => expect(fired).toHaveLength(1));
    expect(fired[0]).toMatchObject({
      note: { id: onSuccess.id },
      body: "Command succeeded: npm run deploy",
    });

    const unmatched = service.list().find((note) => note.id === onFailure.id);
    expect(unmatched?.waitResult).toMatchObject({ matched: false, exitCode: 0 });
    expect(unmatched?.resolvedAt).toBeNull();

    // The note was bound to the command that just succeeded; a later failure does not fire it.
    service.handleCommandFinished({ terminalId: "term-1", exitCode: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fired).toHaveLength(1);
  });

  test("fires a failure note with the exit code", async () => {
    const service = createService();
    await service.start();
    await service.create({
      text: "build",
      quote: "$ make",
      anchor: terminalAnchor,
      wait: { type: "terminal-command", terminalId: "term-1", condition: "failure" },
    });
    service.handleCommandFinished({ terminalId: "term-1", exitCode: 2 });
    await vi.waitFor(() => expect(fired).toHaveLength(1));
    expect(fired[0].body).toBe("Command failed (exit 2)");
  });

  test("fires time notes when due, including ones that came due while stopped", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date("2026-11-01T10:00:00.000Z"));
    const service = createService();
    await service.start();
    await service.create({
      text: "stand-up",
      quote: "meeting",
      anchor: agentAnchor,
      wait: { type: "time", at: "2026-11-01T11:00:00.000Z" },
    });

    await vi.advanceTimersByTimeAsync(59 * 60_000);
    expect(fired).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(fired).toHaveLength(1));
    expect(fired[0]).toMatchObject({ body: "Reminder", push: true });

    await service.create({
      text: "later",
      quote: "q",
      anchor: agentAnchor,
      wait: { type: "time", at: "2026-11-01T12:00:00.000Z" },
    });
    await service.stop();
    vi.setSystemTime(new Date("2026-11-01T13:00:00.000Z"));
    const restarted = createService();
    await restarted.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(fired).toHaveLength(2));
    expect(fired[1].note.text).toBe("later");
  });

  test("skips the push when a phone alerts locally, and skips firing once acknowledged", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date("2026-11-01T10:00:00.000Z"));
    const service = createService();
    await service.start();
    const at = "2026-11-01T10:30:00.000Z";
    await service.create({
      text: "phone covers this",
      quote: "q",
      anchor: agentAnchor,
      wait: { type: "time", at },
      localReminder: { deviceId: "phone", at },
    });
    const acknowledged = await service.create({
      text: "already seen",
      quote: "q",
      anchor: agentAnchor,
      wait: { type: "time", at },
      localReminder: { deviceId: "phone", at },
    });
    await service.edit({ noteId: acknowledged.id, resolved: true });

    await vi.advanceTimersByTimeAsync(30 * 60_000);
    await vi.waitFor(() => expect(fired).toHaveLength(1));
    expect(fired[0]).toMatchObject({ note: { text: "phone covers this" }, push: false });
  });

  test("moving a reminder clears the phone claim and re-arms the note", async () => {
    const service = createService();
    await service.start();
    const at = "2030-01-01T00:00:00.000Z";
    const note = await service.create({
      text: "x",
      quote: "q",
      anchor: agentAnchor,
      wait: { type: "time", at },
      localReminder: { deviceId: "phone", at },
    });
    const moved = await service.edit({
      noteId: note.id,
      wait: { type: "time", at: "2030-01-02T00:00:00.000Z" },
    });
    expect(moved.localReminder).toBeNull();
    await expect(
      service.edit({ noteId: note.id, wait: { type: "time", at: "not a date" } }),
    ).rejects.toThrow("Invalid reminder time");
  });
});
