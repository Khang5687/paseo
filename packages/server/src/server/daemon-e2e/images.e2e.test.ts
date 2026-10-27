import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  createDaemonTestContext,
  DaemonClient,
  type DaemonTestContext,
} from "../test-utils/index.js";
import { createMessageCollector, type MessageCollector } from "../test-utils/message-collector.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-e2e-"));
}

let ctx: DaemonTestContext;
let collector: MessageCollector;

beforeEach(async () => {
  ctx = await createDaemonTestContext();
  collector = createMessageCollector(ctx.client);
});

afterEach(async () => {
  collector.unsubscribe();
  await ctx.cleanup();
}, 60000);

describe("sendImages", () => {
  // Minimal 1x1 red PNG image encoded in base64
  // This is a valid PNG that can be decoded by image processing libraries
  const MINIMAL_PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

  test("sends message with image attachment to Claude agent", async () => {
    const cwd = tmpCwd();

    // Create Claude agent
    const agent = await ctx.client.createAgent({
      provider: "claude",
      cwd,
      title: "Image Test Agent",
    });

    expect(agent.id).toBeTruthy();
    expect(agent.provider).toBe("claude");

    // Send message with image attachment
    await ctx.client.sendMessage(
      agent.id,
      "I'm sending you an image. Describe what information you received about the image attachment. Reply with a single short sentence.",
      {
        images: [
          {
            data: MINIMAL_PNG_BASE64,
            mimeType: "image/png",
          },
        ],
      },
    );

    // Wait for agent to complete
    const finalState = await ctx.client.waitForFinish(agent.id, 120000);

    expect(finalState.status).toBe("idle");
    expect(finalState.final?.lastError).toBeUndefined();

    // Verify stream events show the agent processed the message
    const queue = collector.messages;
    const streamEvents = queue.filter(
      (m) => m.type === "agent_stream" && m.payload.agentId === agent.id,
    );

    // Should have received stream events
    expect(streamEvents.length).toBeGreaterThan(0);

    // Verify turn completed successfully
    const hasTurnCompleted = streamEvents.some(
      (m) => m.type === "agent_stream" && m.payload.event.type === "turn_completed",
    );
    expect(hasTurnCompleted).toBe(true);

    // Verify there was an assistant message in the timeline
    const hasAssistantMessage = streamEvents.some((m) => {
      if (m.type !== "agent_stream" || m.payload.event.type !== "timeline") {
        return false;
      }
      const item = m.payload.event.item;
      return item.type === "assistant_message" && item.text.length > 0;
    });
    expect(hasAssistantMessage).toBe(true);

    // Cleanup
    await ctx.client.deleteAgent(agent.id);
    rmSync(cwd, { recursive: true, force: true });
  }, 180000); // 3 minute timeout for Claude API call

  test("sends message with multiple image attachments", async () => {
    const cwd = tmpCwd();

    // Create Claude agent
    const agent = await ctx.client.createAgent({
      provider: "claude",
      cwd,
      title: "Multi-Image Test Agent",
    });

    expect(agent.id).toBeTruthy();

    // Send message with two image attachments
    await ctx.client.sendMessage(
      agent.id,
      "I'm sending you two images. How many image attachments are mentioned in the context? Reply with just a number.",
      {
        images: [
          {
            data: MINIMAL_PNG_BASE64,
            mimeType: "image/png",
          },
          {
            data: MINIMAL_PNG_BASE64,
            mimeType: "image/jpeg",
          },
        ],
      },
    );

    // Wait for agent to complete
    const finalState = await ctx.client.waitForFinish(agent.id, 120000);

    expect(finalState.status).toBe("idle");
    expect(finalState.final?.lastError).toBeUndefined();

    // Verify turn completed
    const queue = collector.messages;
    const hasTurnCompleted = queue.some(
      (m) =>
        m.type === "agent_stream" &&
        m.payload.agentId === agent.id &&
        m.payload.event.type === "turn_completed",
    );
    expect(hasTurnCompleted).toBe(true);

    // Cleanup
    await ctx.client.deleteAgent(agent.id);
    rmSync(cwd, { recursive: true, force: true });
  }, 180000); // 3 minute timeout for Claude API call
});

describe("user message images", () => {
  const INITIAL_IMAGE = Buffer.from("initial prompt image bytes").toString("base64");
  const FOLLOW_UP_IMAGE = Buffer.from("follow-up image bytes").toString("base64");

  function refOf(base64: string, mimeType: string) {
    const bytes = Buffer.from(base64, "base64");
    return {
      id: createHash("sha256").update(bytes).digest("hex"),
      mimeType,
      size: bytes.byteLength,
    };
  }

  test("another client sees the images of messages one client sent", async () => {
    const cwd = tmpCwd();
    const agent = await ctx.client.createAgent({
      provider: "claude",
      cwd,
      title: "Shared Image Agent",
      initialPrompt: "Look at this",
      clientMessageId: "initial-message",
      images: [{ data: INITIAL_IMAGE, mimeType: "image/png" }],
    });
    await ctx.client.waitForFinish(agent.id, 30000);
    await ctx.client.sendMessage(agent.id, "And this one", {
      messageId: "follow-up-message",
      images: [{ data: FOLLOW_UP_IMAGE, mimeType: "image/jpeg" }],
    });
    await ctx.client.waitForFinish(agent.id, 30000);

    const other = new DaemonClient({ url: `ws://127.0.0.1:${ctx.daemon.port}/ws` });
    try {
      await other.connect();
      const timeline = await other.fetchAgentTimeline(agent.id, { direction: "tail", limit: 50 });
      const userMessages = timeline.entries.flatMap((entry) =>
        entry.item.type === "user_message" ? [entry.item] : [],
      );
      expect(userMessages).toEqual([
        expect.objectContaining({
          text: "Look at this",
          clientMessageId: "initial-message",
          images: [refOf(INITIAL_IMAGE, "image/png")],
        }),
        expect.objectContaining({
          text: "And this one",
          clientMessageId: "follow-up-message",
          images: [refOf(FOLLOW_UP_IMAGE, "image/jpeg")],
        }),
      ]);
      expect(other.getLastServerInfoMessage()?.features?.userMessageImages).toBe(true);

      const [initialRef] = userMessages[0]?.images ?? [];
      const [followUpRef] = userMessages[1]?.images ?? [];
      await expect(other.getAgentTimelineImage(agent.id, initialRef!.id)).resolves.toBe(
        INITIAL_IMAGE,
      );
      await expect(other.getAgentTimelineImage(agent.id, followUpRef!.id)).resolves.toBe(
        FOLLOW_UP_IMAGE,
      );

      // The images belong to the agent: deleting it deletes them.
      await ctx.client.deleteAgent(agent.id);
      await expect(other.getAgentTimelineImage(agent.id, initialRef!.id)).resolves.toBeNull();
    } finally {
      await other.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 60000);
});
