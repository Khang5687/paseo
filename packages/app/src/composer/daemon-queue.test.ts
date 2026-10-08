import { describe, expect, it } from "vitest";
import type { ComposerAttachment } from "@/attachments/types";
import type { AgentQueuedMessagePayload } from "@getpaseo/protocol/messages";
import type { UserMessageItem } from "@/types/stream";
import type { MessageSubmissionWriter, QueuedComposerMessage, QueueWriter } from "./actions";
import {
  pruneLocalMirror,
  queueMessageOnDaemon,
  restoreQueuedMessageFromDaemon,
  sendQueuedMessageNowOnDaemon,
  type DaemonQueueClient,
} from "./daemon-queue";

function createMirror(): QueueWriter & { state: Map<string, QueuedComposerMessage[]> } {
  const holder = { state: new Map<string, QueuedComposerMessage[]>() };
  return {
    get state() {
      return holder.state;
    },
    read: (agentId) => holder.state.get(agentId) ?? [],
    write: (updater) => {
      holder.state = updater(holder.state);
    },
  };
}

function createClient(): DaemonQueueClient & {
  queue: AgentQueuedMessagePayload[];
  sentNow: string[];
} {
  const queue: AgentQueuedMessagePayload[] = [];
  const sentNow: string[] = [];
  let counter = 0;
  return {
    queue,
    sentNow,
    addQueuedAgentMessage: async (input) => {
      const entry: AgentQueuedMessagePayload = {
        id: `q-${++counter}`,
        text: input.text,
        createdAt: "2026-10-02T00:00:00.000Z",
        images: input.images ?? [],
        attachments: input.attachments ?? [],
      };
      queue.push(entry);
      return {
        id: entry.id,
        text: entry.text,
        createdAt: entry.createdAt,
        imageCount: entry.images.length,
        attachmentCount: entry.attachments.length,
      };
    },
    removeQueuedAgentMessage: async (input) => {
      const index = queue.findIndex((item) => item.id === input.messageId);
      if (index === -1) throw new Error("not queued");
      const [removed] = queue.splice(index, 1);
      return removed;
    },
    sendQueuedAgentMessageNow: async (input) => {
      sentNow.push(input.messageId);
      const index = queue.findIndex((item) => item.id === input.messageId);
      if (index !== -1) queue.splice(index, 1);
    },
  };
}

function createSubmissionWriter(): MessageSubmissionWriter & {
  begun: UserMessageItem[];
  accepted: string[];
  rejected: string[];
} {
  const begun: UserMessageItem[] = [];
  const accepted: string[] = [];
  const rejected: string[] = [];
  return {
    begun,
    accepted,
    rejected,
    begin: (_agentId, message) => {
      begun.push(message);
    },
    accept: (_agentId, clientMessageId) => {
      accepted.push(clientMessageId);
    },
    reject: (_agentId, clientMessageId) => {
      rejected.push(clientMessageId);
      return "rejected";
    },
  };
}

const imageAttachment: ComposerAttachment = {
  kind: "image",
  metadata: {
    id: "img-1",
    mimeType: "image/png",
    storageType: "web-indexeddb",
    storageKey: "img-1",
    fileName: "shot.png",
    createdAt: 1,
  },
};

describe("daemon-owned queue", () => {
  it("queues the encoded wire form and mirrors the composer form locally", async () => {
    const client = createClient();
    const mirror = createMirror();
    const summary = await queueMessageOnDaemon({
      client,
      agentId: "agent-1",
      text: "later",
      attachments: [imageAttachment],
      encodeImages: async (images) =>
        images.map((image) => ({ data: "AAAA", mimeType: image.mimeType })),
      localMirror: mirror,
    });
    expect(summary).toMatchObject({ text: "later", imageCount: 1, attachmentCount: 0 });
    expect(client.queue[0]?.images).toEqual([{ data: "AAAA", mimeType: "image/png" }]);
    expect(mirror.read("agent-1")).toEqual([
      { id: summary.id, text: "later", attachments: [imageAttachment] },
    ]);
  });

  it("restores a same-client entry losslessly and a cross-client entry from the wire form", async () => {
    const client = createClient();
    const mirror = createMirror();
    const persisted: string[] = [];
    const persister = {
      persistFromDataUrl: async (input: { dataUrl: string; mimeType: string }) => {
        persisted.push(input.dataUrl);
        return {
          id: `restored-${persisted.length}`,
          mimeType: input.mimeType,
          storageType: "web-indexeddb" as const,
          storageKey: `restored-${persisted.length}`,
          fileName: null,
          createdAt: 2,
        };
      },
    };
    const mine = await queueMessageOnDaemon({
      client,
      agentId: "agent-1",
      text: "mine",
      attachments: [imageAttachment],
      encodeImages: async () => [{ data: "AAAA", mimeType: "image/png" }],
      localMirror: mirror,
    });
    // Queued elsewhere: present on the daemon, absent from this client's mirror.
    const theirs = await client.addQueuedAgentMessage({
      agentId: "agent-1",
      text: "theirs",
      images: [{ data: "BBBB", mimeType: "image/jpeg" }],
      attachments: [
        {
          type: "uploaded_file",
          id: "f1",
          fileName: "notes.txt",
          mimeType: "text/plain",
          size: 3,
          path: "/tmp/notes.txt",
        },
        { type: "text", mimeType: "text/plain", title: "ctx", text: "cannot be rebuilt" },
      ],
    });

    const restoredMine = await restoreQueuedMessageFromDaemon({
      client,
      agentId: "agent-1",
      messageId: mine.id,
      localMirror: mirror,
      persister,
    });
    expect(restoredMine.attachments).toEqual([imageAttachment]);
    expect(persisted).toEqual([]);
    expect(mirror.read("agent-1")).toEqual([]);

    const restoredTheirs = await restoreQueuedMessageFromDaemon({
      client,
      agentId: "agent-1",
      messageId: theirs.id,
      localMirror: mirror,
      persister,
    });
    expect(restoredTheirs.text).toBe("theirs");
    expect(persisted).toEqual(["data:image/jpeg;base64,BBBB"]);
    expect(restoredTheirs.attachments).toEqual([
      {
        kind: "image",
        metadata: {
          id: "restored-1",
          mimeType: "image/jpeg",
          storageType: "web-indexeddb",
          storageKey: "restored-1",
          fileName: null,
          createdAt: 2,
        },
      },
      {
        kind: "file",
        attachment: {
          type: "uploaded_file",
          id: "f1",
          fileName: "notes.txt",
          mimeType: "text/plain",
          size: 3,
          path: "/tmp/notes.txt",
        },
      },
    ]);
    expect(client.queue).toEqual([]);
  });

  it("send-now and pruning drop mirror entries the daemon no longer lists", async () => {
    const client = createClient();
    const mirror = createMirror();
    const first = await queueMessageOnDaemon({
      client,
      agentId: "agent-1",
      text: "first",
      attachments: [],
      encodeImages: async () => [],
      localMirror: mirror,
    });
    const second = await queueMessageOnDaemon({
      client,
      agentId: "agent-1",
      text: "second",
      attachments: [],
      encodeImages: async () => [],
      localMirror: mirror,
    });

    const submission = createSubmissionWriter();
    await sendQueuedMessageNowOnDaemon({
      client,
      agentId: "agent-1",
      messageId: second.id,
      activeTurnBehavior: "steer",
      activeTurnId: "turn-1",
      localMirror: mirror,
      summary: null,
      submission,
    });
    expect(client.sentNow).toEqual([second.id]);
    expect(mirror.read("agent-1").map((item) => item.id)).toEqual([first.id]);
    // The row is keyed by the entry id so the daemon's canonical user_message
    // (recorded under the same clientMessageId) reconciles with it.
    expect(submission.begun.map((item) => [item.clientMessageId, item.text, item.turnId])).toEqual([
      [second.id, "second", "turn-1"],
    ]);
    expect(submission.accepted).toEqual([second.id]);
    expect(submission.rejected).toEqual([]);

    // The daemon dispatched `first` on idle; the next snapshot lists nothing.
    const before = mirror.state;
    pruneLocalMirror(mirror, "agent-1", []);
    expect(mirror.state.has("agent-1")).toBe(false);

    // No-op prunes keep the same map instance so store subscribers do not rerender.
    const unchanged = mirror.state;
    pruneLocalMirror(mirror, "agent-1", []);
    expect(mirror.state).toBe(unchanged);
    expect(before).not.toBe(unchanged);
  });

  it("send-now renders a cross-client entry from the summary and drops the row if the host rejects", async () => {
    const client = createClient();
    const mirror = createMirror();
    const theirs = await client.addQueuedAgentMessage({ agentId: "agent-1", text: "theirs" });
    const failing: DaemonQueueClient = {
      ...client,
      sendQueuedAgentMessageNow: async () => {
        throw new Error("host rejected");
      },
    };
    const submission = createSubmissionWriter();

    await expect(
      sendQueuedMessageNowOnDaemon({
        client: failing,
        agentId: "agent-1",
        messageId: theirs.id,
        activeTurnBehavior: "interrupt",
        localMirror: mirror,
        summary: theirs,
        submission,
      }),
    ).rejects.toThrow("host rejected");

    expect(submission.begun.map((item) => [item.clientMessageId, item.text, item.turnId])).toEqual([
      [theirs.id, "theirs", undefined],
    ]);
    expect(submission.rejected).toEqual([theirs.id]);
    expect(submission.accepted).toEqual([]);
    // The daemon still lists the entry; nothing local claims it.
    expect(client.queue.map((item) => item.id)).toEqual([theirs.id]);
    expect(mirror.state.has("agent-1")).toBe(false);
  });
});
