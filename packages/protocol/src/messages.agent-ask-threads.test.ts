import { describe, expect, test } from "vitest";

import { SessionInboundMessageSchema, SessionOutboundMessageSchema } from "./messages.js";

describe("agent.ask thread fields", () => {
  test("an old request without thread fields still parses and gains none", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "agent.ask.request",
      agentId: "agent-1",
      question: "What is the plan?",
      requestId: "ask-1",
    });
    expect(parsed).toEqual({
      type: "agent.ask.request",
      agentId: "agent-1",
      question: "What is the plan?",
      requestId: "ask-1",
    });
  });

  test("a request carries the thread, the action, and the asker's agent id", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "agent.ask.request",
      agentId: "agent-1",
      question: "",
      requestId: "ask-2",
      threadId: "t1",
      threadAction: "close",
      askerAgentId: "agent-9",
    });
    expect(parsed).toMatchObject({
      threadId: "t1",
      threadAction: "close",
      askerAgentId: "agent-9",
    });
  });

  test("an unknown thread action is rejected", () => {
    expect(() =>
      SessionInboundMessageSchema.parse({
        type: "agent.ask.request",
        agentId: "agent-1",
        question: "x",
        requestId: "ask-3",
        threadAction: "reopen",
      }),
    ).toThrow();
  });

  test("a response from an old daemon, without thread info, parses", () => {
    const parsed = SessionOutboundMessageSchema.parse({
      type: "agent.ask.response",
      payload: { requestId: "ask-1", agentId: "agent-1", answer: "Ship it.", error: null },
    });
    expect(parsed).toMatchObject({ payload: { answer: "Ship it." } });
  });

  test("a response carries thread state with notes", () => {
    const thread = {
      threadId: "t1",
      status: "closed" as const,
      round: 10,
      maxRounds: 10,
      roundsLeft: 0,
      closeReason: "round limit reached",
      sourceTurnsSince: 3,
      notes: ["This was the last round (10 of 10). The thread is closed."],
    };
    const parsed = SessionOutboundMessageSchema.parse({
      type: "agent.ask.response",
      payload: { requestId: "ask-4", agentId: "agent-1", answer: null, error: null, thread },
    });
    expect(parsed).toMatchObject({ payload: { thread } });
  });

  test("a read request carries a cursor and the paging marker", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "agent.ask.request",
      agentId: "agent-1",
      question: "",
      requestId: "ask-5",
      threadAction: "read",
      readCursor: "opaque",
      replyPaging: {},
    });
    expect(parsed).toMatchObject({ threadAction: "read", readCursor: "opaque", replyPaging: {} });
  });

  test("a response carries one page of a long reply; the last page has no next cursor", () => {
    const reply = {
      replyId: "r1",
      round: 1,
      page: 3,
      pages: 3,
      totalChars: 9000,
      expiresAt: "2030-01-01T00:30:00.000Z",
      nextCursor: null,
    };
    const parsed = SessionOutboundMessageSchema.parse({
      type: "agent.ask.response",
      payload: { requestId: "ask-6", agentId: "agent-1", answer: "end", error: null, reply },
    });
    expect(parsed).toMatchObject({ payload: { reply } });
  });

  test("a malformed reply page is rejected", () => {
    expect(() =>
      SessionOutboundMessageSchema.parse({
        type: "agent.ask.response",
        payload: {
          requestId: "ask-7",
          agentId: "agent-1",
          answer: "x",
          error: null,
          reply: { replyId: "r1", round: 1, page: 0, pages: 1, totalChars: 1, expiresAt: "t" },
        },
      }),
    ).toThrow();
  });
});
