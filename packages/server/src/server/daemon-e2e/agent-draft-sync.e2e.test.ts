import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import type { AgentDraftUpdateMessage, SessionOutboundMessage } from "../messages.js";

type DraftUpdate = AgentDraftUpdateMessage["payload"];

let ctx: DaemonTestContext;
let clientB: DaemonClient;
let cwd: string;

beforeEach(async () => {
  ctx = await createDaemonTestContext();
  clientB = new DaemonClient({ url: `ws://127.0.0.1:${ctx.daemon.port}/ws` });
  await clientB.connect();
  cwd = mkdtempSync(path.join(tmpdir(), "daemon-e2e-draft-"));
});

afterEach(async () => {
  await clientB.close();
  await ctx.cleanup();
  rmSync(cwd, { recursive: true, force: true });
}, 60000);

function collectDraftUpdates(client: DaemonClient, agentId: string) {
  const updates: DraftUpdate[] = [];
  const subscription = client.observeAgentDraft(agentId);
  subscription.subscribe({
    snapshot: () => {},
    update: (message: SessionOutboundMessage) => {
      if (message.type === "agent.draft.update") updates.push(message.payload);
    },
  });
  async function waitFor(predicate: (update: DraftUpdate) => boolean): Promise<DraftUpdate> {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const match = updates.find(predicate);
      if (match) return match;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Timed out waiting for agent.draft.update");
  }
  return { subscription, waitFor };
}

test("client A's draft reaches client B and sending clears it on both", async () => {
  const agent = await ctx.client.createAgent({ provider: "codex", cwd, title: "Draft sync" });
  const onB = collectDraftUpdates(clientB, agent.id);
  const initial = await onB.subscription.ready;
  expect(initial.state?.draft ?? null).toBeNull();

  const typed = await ctx.client.setAgentDraft({
    agentId: agent.id,
    text: "fix the login redirect",
    attachments: [],
    updatedAt: Date.now(),
    baseRevision: null,
  });
  expect(typed.accepted).toBe(true);
  const seen = await onB.waitFor((update) => update.draft?.text === "fix the login redirect");
  expect(seen.draft?.revision).toBe(typed.state?.draft?.revision);

  await ctx.client.setAgentDraft({
    agentId: agent.id,
    text: "",
    attachments: [],
    updatedAt: Date.now(),
    baseRevision: seen.draft?.revision ?? null,
    reason: "sent",
  });
  const cleared = await onB.waitFor((update) => update.draft?.text === "");
  expect(cleared.history?.[0]?.preview).toBe("fix the login redirect");

  // A late subscriber (another device opening the chat) gets the cleared draft and the history.
  const late = await clientB.observeAgentDraft(agent.id).ready;
  expect(late.state?.draft?.text).toBe("");
  expect(late.state?.history.map((entry) => entry.preview)).toEqual(["fix the login redirect"]);
});

test("a stale offline write loses to a newer draft and lands in the history", async () => {
  const agent = await ctx.client.createAgent({ provider: "codex", cwd, title: "Draft conflict" });
  const now = Date.now();
  await ctx.client.setAgentDraft({
    agentId: agent.id,
    text: "newer text from the phone",
    attachments: [],
    updatedAt: now,
    baseRevision: null,
  });

  const stale = await clientB.setAgentDraft({
    agentId: agent.id,
    text: "older offline text",
    attachments: [],
    updatedAt: now - 60_000,
    baseRevision: null,
  });
  expect(stale.accepted).toBe(false);
  expect(stale.state?.draft?.text).toBe("newer text from the phone");

  const restored = await clientB.restoreAgentDraft(agent.id, stale.state!.history[0]!.id);
  expect(restored.state?.draft?.text).toBe("older offline text");
});

test("another client fetches a draft image, and removing it deletes the upload", async () => {
  const agent = await ctx.client.createAgent({ provider: "codex", cwd, title: "Draft image" });
  const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
  const uploaded = await ctx.client.uploadFile({
    fileName: "shot.png",
    mimeType: "image/png",
    bytes,
  });
  const uploadId = uploaded.file!.id;
  const image = { kind: "image", uploadId, value: { mimeType: "image/png" } };
  const first = await ctx.client.setAgentDraft({
    agentId: agent.id,
    text: "see screenshot",
    attachments: [image],
    updatedAt: Date.now(),
    baseRevision: null,
  });

  const fetched = await clientB.getAgentDraftUpload(agent.id, uploadId);
  expect(Buffer.from(fetched.data, "base64")).toEqual(Buffer.from(bytes));

  const uploadDir = path.join(ctx.daemon.paseoHome, "uploads", uploadId);
  expect(existsSync(uploadDir)).toBe(true);
  await ctx.client.setAgentDraft({
    agentId: agent.id,
    text: "see screenshot",
    attachments: [],
    updatedAt: Date.now(),
    baseRevision: first.state?.draft?.revision ?? null,
  });
  expect(existsSync(uploadDir)).toBe(false);
  await expect(clientB.getAgentDraftUpload(agent.id, uploadId)).rejects.toThrow();
});

test("archiving an agent deletes its draft, history and uploads", async () => {
  const agent = await ctx.client.createAgent({ provider: "codex", cwd, title: "Draft archive" });
  const uploaded = await ctx.client.uploadFile({
    fileName: "shot.png",
    mimeType: "image/png",
    bytes: new Uint8Array([1, 2, 3]),
  });
  const uploadId = uploaded.file!.id;
  const typed = await ctx.client.setAgentDraft({
    agentId: agent.id,
    text: "draft with an image",
    attachments: [{ kind: "image", uploadId, value: {} }],
    updatedAt: Date.now(),
    baseRevision: null,
  });
  await ctx.client.setAgentDraft({
    agentId: agent.id,
    text: "",
    attachments: [],
    updatedAt: Date.now(),
    baseRevision: typed.state?.draft?.revision ?? null,
  });

  await ctx.client.archiveAgent(agent.id);

  expect(existsSync(path.join(ctx.daemon.paseoHome, "uploads", uploadId))).toBe(false);
  const record = await ctx.daemon.daemon.agentStorage.get(agent.id);
  expect(record?.draft).toBeUndefined();
  expect(record?.draftHistory).toBeUndefined();
});
