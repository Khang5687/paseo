import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { afterEach, expect, test } from "vitest";

import { createHostResolver, type HostOperations } from "./index.js";

type Handler = ((event?: unknown) => void) | null;

const clients: DaemonClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

/** A connected host that answers agent.ask.request and records what it was sent. */
class AskHostSocket {
  readyState = 1;
  readonly asks: Array<Record<string, unknown>> = [];
  onopen: Handler = null;
  onmessage: Handler = null;
  onclose: Handler = null;
  onerror: Handler = null;

  constructor(private readonly features: Record<string, boolean>) {
    queueMicrotask(() => this.onopen?.());
  }

  send(data: string): void {
    const frame = JSON.parse(data);
    if (frame.type === "hello") {
      this.reply({
        type: "status",
        payload: {
          status: "server_info",
          serverId: "srv_ask",
          hostname: null,
          version: null,
          features: this.features,
        },
      });
      return;
    }
    if (frame.type !== "session" || frame.message.type !== "agent.ask.request") return;
    this.asks.push(frame.message);
    const thread = {
      threadId: "t-remote",
      status: "open",
      round: 2,
      maxRounds: 10,
      roundsLeft: 8,
      sourceTurnsSince: 1,
      notes: [],
    };
    const reply = {
      replyId: "r1",
      round: 1,
      page: frame.message.threadAction === "read" ? 2 : 1,
      pages: 3,
      totalChars: 150,
      expiresAt: "2030-01-01T00:30:00.000Z",
      nextCursor: frame.message.threadAction === "read" ? "cursor-3" : "cursor-2",
    };
    const paged = this.features.agentAskReplyPaging && frame.message.replyPaging !== undefined;
    const reading = frame.message.threadAction === "read";
    let answer: string | null = "remote answer";
    if (frame.message.threadAction) answer = null;
    if (reading) answer = "page 2";
    this.reply({
      type: "agent.ask.response",
      payload: {
        requestId: frame.message.requestId,
        agentId: frame.message.agentId,
        answer,
        error: null,
        ...(this.features.agentAskThreads && !reading ? { thread } : {}),
        ...(paged && (reading || frame.message.question === "long") ? { reply } : {}),
      },
    });
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: "closed" });
  }

  private reply(message: object): void {
    this.onmessage?.({ data: JSON.stringify({ type: "session", message }) });
  }
}

async function askHost(features: Record<string, boolean>) {
  const socket = new AskHostSocket(features);
  const client = new DaemonClient({
    url: "ws://ask.test",
    clientId: "ask-host-test",
    webSocketFactory: () => socket,
    reconnect: { enabled: false },
  });
  clients.push(client);
  await client.connect();
  const resolver = createHostResolver({
    serverId: "origin",
    callerAgentId: "caller-1",
    caller: () => ({ background: false }),
    callerTitle: () => "planner",
    local: {} as HostOperations,
    hosts: () => ({
      directory: async () => ({ self: { serverId: "origin", label: "Origin" }, hosts: [] }),
      use: (_serverId, action) => action(client),
    }),
  });
  return {
    socket,
    ask: (args: Record<string, unknown>) =>
      resolver.use("srv_ask", (host) => host.askAgent(args, {} as never)),
  };
}

test("a remote ask sends the thread, the action and who is asking, and returns the thread state", async () => {
  const { socket, ask } = await askHost({ agentAsk: true, agentAskThreads: true });

  const reply = await ask({ agentId: "agent-9", question: "Why?", threadId: "t-remote" });
  const closed = await ask({ agentId: "agent-9", close: true, threadId: "t-remote" });

  expect(socket.asks[0]).toMatchObject({
    agentId: "agent-9",
    question: "Why?",
    threadId: "t-remote",
    askedBy: "planner",
    askerAgentId: "caller-1",
  });
  expect(socket.asks[0]).not.toHaveProperty("threadAction");
  expect(socket.asks[1]).toMatchObject({ threadAction: "close", threadId: "t-remote" });
  expect(reply.structuredContent).toMatchObject({
    agentId: "agent-9",
    threadId: "t-remote",
    answer: "remote answer",
    thread: { round: 2, roundsLeft: 8 },
  });
  expect(closed.structuredContent).toMatchObject({ answer: null, threadId: "t-remote" });
});

test("a host from before ask threads still answers a plain ask, and refuses thread options", async () => {
  const { socket, ask } = await askHost({ agentAsk: true });

  const reply = await ask({ agentId: "agent-9", question: "Why?" });

  expect(reply.structuredContent).toMatchObject({ answer: "remote answer" });
  expect(reply.structuredContent).not.toHaveProperty("threadId");
  await expect(ask({ agentId: "agent-9", question: "More?", threadId: "t-1" })).rejects.toThrow(
    "Update Paseo on that host to continue ask_agent threads.",
  );
  await expect(ask({ agentId: "agent-9", status: true, threadId: "t-1" })).rejects.toThrow(
    "Update Paseo on that host to continue ask_agent threads.",
  );
  expect(socket.asks).toHaveLength(1);
});

test("a remote read passes the cursor and returns the page with the next cursor", async () => {
  const { socket, ask } = await askHost({
    agentAsk: true,
    agentAskThreads: true,
    agentAskReplyPaging: true,
  });

  const first = await ask({ agentId: "agent-9", question: "long" });
  const page = await ask({ agentId: "agent-9", cursor: "cursor-2" });

  expect(socket.asks[0]).toMatchObject({ replyPaging: {} });
  expect(socket.asks[1]).toMatchObject({
    threadAction: "read",
    readCursor: "cursor-2",
    askerAgentId: "caller-1",
    replyPaging: {},
  });
  expect(first.structuredContent).toMatchObject({
    answer: "remote answer",
    reply: { page: 1, pages: 3, next: { agentId: "agent-9", cursor: "cursor-2" } },
  });
  expect(page.structuredContent).toMatchObject({
    answer: "page 2",
    reply: { page: 2, next: { agentId: "agent-9", cursor: "cursor-3" } },
  });
});

test("a host from before reply paging refuses a cursor read with an update hint, and is not told about paging", async () => {
  const { socket, ask } = await askHost({ agentAsk: true, agentAskThreads: true });

  await expect(ask({ agentId: "agent-9", cursor: "cursor-2" })).rejects.toThrow(
    "Update Paseo on that host to read long replies.",
  );
  await ask({ agentId: "agent-9", question: "Why?" });

  expect(socket.asks).toHaveLength(1);
  expect(socket.asks[0]).not.toHaveProperty("replyPaging");
  expect(socket.asks[0]).not.toHaveProperty("readCursor");
});
