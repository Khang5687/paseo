import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";

let ctx: DaemonTestContext;
let cwd: string;

beforeEach(async () => {
  // Command events need Paseo's shell integration; bash is the shell present on every CI host.
  vi.stubEnv("SHELL", "/bin/bash");
  vi.stubEnv("BASH_SILENCE_DEPRECATION_WARNING", "1");
  ctx = await createDaemonTestContext();
  cwd = mkdtempSync(path.join(tmpdir(), "daemon-notes-e2e-"));
});

afterEach(async () => {
  await ctx.cleanup();
  vi.unstubAllEnvs();
  rmSync(cwd, { recursive: true, force: true });
}, 60000);

async function waitFor<T>(read: () => T | undefined, timeoutMs = 15000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

test("a terminal note fires when its command fails and syncs to subscribers", async () => {
  expect(ctx.client.getLastServerInfoMessage()?.features?.notes).toBe(true);
  const opened = await ctx.client.openProject(cwd);
  const workspaceId = opened.workspace?.id;
  if (!workspaceId) throw new Error(opened.error ?? "Failed to open workspace");
  const created = await ctx.client.createTerminal(cwd, undefined, undefined, { workspaceId });
  const terminalId = created.terminal?.id;
  if (!terminalId) throw new Error("Failed to create terminal");

  const changes: SessionOutboundMessage[] = [];
  const notes = ctx.client.observeNotes();
  notes.subscribe({ snapshot: () => {}, update: (message) => changes.push(message) });
  expect((await notes.ready).notes).toEqual([]);

  const fired: SessionOutboundMessage[] = [];
  const events = ctx.client.observeEvents(["notes.fired"], { notifications: true });
  events.subscribe({ snapshot: () => {}, update: (message) => fired.push(message) });
  await events.ready;

  const note = await ctx.client.createNote({
    text: "tests broke",
    quote: "$ false",
    anchor: { kind: "terminal", terminalId, workspaceId, startLine: 0, endLine: 0 },
    wait: { type: "terminal-command", terminalId, condition: "failure", command: "false" },
  });
  expect(note.wait).toMatchObject({ type: "terminal-command", condition: "failure" });

  // Input typed before the first prompt waits in the pty; the shell reads it after its rc files
  // installed the integration hooks.
  ctx.client.sendTerminalInput(terminalId, { type: "input", data: "false\r" });

  const firedMessage = await waitFor(() => fired.find((message) => message.type === "notes.fired"));
  if (firedMessage.type !== "notes.fired") throw new Error("unreachable");
  expect(firedMessage.payload).toMatchObject({
    title: "Done: tests broke",
    body: "Command failed (exit 1): false",
    note: { id: note.id, waitResult: { matched: true, exitCode: 1 } },
  });

  const resolvedChange = await waitFor(() =>
    changes.find(
      (message) =>
        message.type === "notes.changed" &&
        message.payload.kind === "upsert" &&
        message.payload.note.resolvedAt != null,
    ),
  );
  expect(resolvedChange).toBeDefined();
  const [listed] = await ctx.client.listNotes();
  expect(listed).toMatchObject({ id: note.id, waitResult: { matched: true } });
  expect(listed.resolvedAt).toEqual(expect.any(String));

  await ctx.client.deleteNote(note.id);
  expect(await ctx.client.listNotes()).toEqual([]);
  await notes.release();
  await events.release();
}, 60000);
