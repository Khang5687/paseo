import pino from "pino";
import { describe, expect, test, vi } from "vitest";

import type { AgentTimelineItem } from "../../agent/agent-sdk-types.js";
import type { VoiceChatProject } from "@getpaseo/protocol/voice/chat-directory";
import {
  buildSideHelperChats,
  buildSideHelperContext,
  createVoiceSideHelper,
  DEFAULT_SIDE_HELPER_MODEL,
  findNamedChats,
  parseSideHelperCall,
  parseSideHelperModel,
  runSideHelperModel,
  SIDE_HELPER_SYSTEM_PROMPT,
  type SideHelperChatInfo,
} from "./voice-side-helper.js";

const MAIN_ID = "11111111-1111-4111-8111-111111111111";
const SCAN_ID = "22222222-2222-4222-8222-222222222222";
const RELEASE_ID = "33333333-3333-4333-8333-333333333333";

const directory: VoiceChatProject[] = [
  {
    projectId: "fitup",
    name: "FitUp",
    chats: [
      { agentId: MAIN_ID, workspaceId: "w-1", title: "Main chat", lastActiveAt: 3 },
      { agentId: SCAN_ID, workspaceId: "w-2", title: "Food scan redesign", lastActiveAt: 2 },
    ],
  },
  {
    projectId: "paseo",
    name: "Paseo",
    chats: [{ agentId: RELEASE_ID, workspaceId: "w-3", title: "Release beta", lastActiveAt: 1 }],
  },
];

describe("parseSideHelperCall", () => {
  test.each([
    // What Parakeet wrote for spoken "Paseo, ..." on this host.
    ["Paceo, what's going on in Fit Up?", "what's going on in Fit Up?"],
    ["Pacio, read me the last three replies.", "read me the last three replies."],
    ["Paseo, go to fitup.", "go to fitup."],
    ["Hey Paceo, what's new?", "what's new?"],
    ["Pass say oh, which chats are waiting on me?", "which chats are waiting on me?"],
    ["PASEO: list chats", "list chats"],
  ])("%s asks the helper", (transcript, question) => {
    expect(parseSideHelperCall(transcript)).toEqual({ kind: "question", question });
  });

  test.each([
    // No pause after the name: talk about the app, for the chat.
    "Paceo app crashes when I open settings.",
    // The name inside a sentence, English and Vietnamese.
    "Tell Paseo, the app, to stop.",
    "Anh muốn Paseo, mở cái chat fitup giúp anh.",
    "Paseo bị lỗi rồi, sửa giúp anh",
    // Words that only start like the name.
    "Pasta, please.",
    "Paste, then run it.",
    "",
  ])("%j stays chat", (transcript) => {
    expect(parseSideHelperCall(transcript)).toBeNull();
  });

  test("the name alone wakes the helper for the next words", () => {
    expect(parseSideHelperCall("Paceo.")).toEqual({ kind: "wake" });
    expect(parseSideHelperCall("Hey Paseo")).toEqual({ kind: "wake" });
  });
});

describe("findNamedChats", () => {
  test("a project name gives its newest chat and a title run gives that chat", () => {
    expect(
      findNamedChats("what's going on in fit up?", directory).map((t) => t.chat.agentId),
    ).toEqual([MAIN_ID]);
    expect(findNamedChats("what did food scan say?", directory).map((t) => t.chat.agentId)).toEqual(
      [SCAN_ID],
    );
  });

  test("question words name no chat", () => {
    expect(findNamedChats("which chats are waiting on me?", directory)).toEqual([]);
    expect(findNamedChats("what did the agent just say?", directory)).toEqual([]);
  });
});

describe("buildSideHelperContext", () => {
  const now = 10 * 60 * 60_000;

  function manyChats(count: number): SideHelperChatInfo[] {
    return Array.from({ length: count }, (_, index) => ({
      ref: `c${index + 1}`,
      agentId: `agent-${index}`,
      projectName: `Project ${index}`,
      title: `A chat with a fairly long title number ${index}`,
      status: "idle",
      waiting: null,
      lastActiveAt: now - index * 60_000,
    }));
  }

  test("stays within the token cap, keeps the newest messages and says what it left out", () => {
    const chats = manyChats(400);
    chats[399] = { ...chats[399], waiting: "approval: Bash" };
    const longTimeline = Array.from({ length: 200 }, (_, i) => `[User] message ${i}`).join("\n");
    const context = buildSideHelperContext(
      {
        now,
        currentAgentId: "agent-5",
        chats,
        timelines: [
          { projectName: "Project 5", title: "Current", isCurrent: true, text: longTimeline },
        ],
      },
      1000,
    );
    expect(context.length).toBeLessThanOrEqual(1000 * 4);
    expect(context).toContain("[User] message 199");
    expect(context).not.toContain("[User] message 0\n");
    expect(context).toMatch(/- and \d+ more chats not listed/);
    const lines = context.split("\n");
    const listStart = lines.findIndex((line) => line.startsWith("## Chats (400)"));
    // The current chat first, then the one waiting on the owner, though it is the oldest.
    expect(lines[listStart + 1]).toContain("this is the chat voice is in");
    expect(lines[listStart + 2]).toContain("waiting on you: approval: Bash");
  });

  test("the chat list says why a chat waits on the owner", () => {
    const chats = buildSideHelperChats(directory, [
      {
        id: SCAN_ID,
        status: "idle",
        pendingPermissions: [
          {
            kind: "tool",
            name: "Bash",
            title: "Run npm test",
            detail: { type: "shell", command: "npm test -- --bail" },
          },
        ],
      },
      {
        id: RELEASE_ID,
        status: "idle",
        openQuestions: [{ label: "Q12", title: "Ship the beta tonight?" }],
        pendingPermissions: [],
      },
    ]);
    expect(chats.map((chat) => [chat.ref, chat.title, chat.waiting])).toEqual([
      ["c1", "Main chat", null],
      ["c2", "Food scan redesign", "approval: Run npm test: npm test -- --bail"],
      ["c3", "Release beta", "asked Q12 Ship the beta tonight?"],
    ]);
  });
});

test("a model setting without a provider falls back to the default", () => {
  expect(parseSideHelperModel("omp/anthropic/claude-sonnet-5-5")).toEqual({
    provider: "omp",
    model: "anthropic/claude-sonnet-5-5",
  });
  expect(parseSideHelperModel("haiku")).toEqual(parseSideHelperModel(DEFAULT_SIDE_HELPER_MODEL));
  expect(parseSideHelperModel(undefined)).toEqual({
    provider: "omp",
    model: "anthropic/claude-haiku-5-5",
  });
});

type Listener = (event: unknown) => void;

function createFakeManager(run: (signal: { cancelled: boolean }) => Promise<unknown>) {
  const listeners: Listener[] = [];
  const state = { cancelled: false };
  const manager = {
    createAgent: vi.fn(async () => ({ id: "helper-agent" })),
    runAgent: vi.fn(() => run(state)),
    cancelAgentRun: vi.fn(async () => {
      state.cancelled = true;
      return true;
    }),
    closeAgent: vi.fn(async () => {}),
    deleteAgentState: vi.fn(async () => {}),
    respondToPermission: vi.fn(async () => {}),
    subscribe: vi.fn((listener: Listener) => {
      listeners.push(listener);
      return () => listeners.splice(listeners.indexOf(listener), 1);
    }),
    emit: (event: unknown) => {
      for (const listener of listeners) listener(event);
    },
    listeners,
  };
  return manager;
}

function asManager(fake: ReturnType<typeof createFakeManager>) {
  return fake as unknown as Parameters<typeof runSideHelperModel>[0]["manager"];
}

describe("runSideHelperModel", () => {
  test("runs one hidden agent in the safe mode, denies every approval, and deletes it", async () => {
    const fake = createFakeManager(async () => {
      fake.emit({
        type: "agent_stream",
        agentId: "helper-agent",
        event: { type: "permission_requested", provider: "omp", request: { id: "req-1" } },
      });
      // OMP reports usage after the turn, not in its result.
      return { finalText: " Two chats wait on you. " };
    });
    const answer = await runSideHelperModel({
      manager: asManager(fake),
      choice: { provider: "omp", model: "anthropic/claude-haiku-5-5" },
      cwd: "/tmp/empty",
      prompt: "question",
      signal: new AbortController().signal,
    });
    expect(answer.text).toBe("Two chats wait on you.");
    fake.emit({
      type: "agent_stream",
      agentId: "helper-agent",
      event: { type: "usage_updated", provider: "omp", usage: { inputTokens: 900 } },
    });
    await expect(answer.usage).resolves.toEqual({ inputTokens: 900 });
    expect(fake.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "omp",
        internal: true,
        modeId: "ask",
        cwd: "/tmp/empty",
        systemPrompt: SIDE_HELPER_SYSTEM_PROMPT,
      }),
      undefined,
      { persistSession: false, workspaceId: undefined, toolless: true },
    );
    expect(fake.respondToPermission).toHaveBeenCalledWith(
      "helper-agent",
      "req-1",
      expect.objectContaining({ behavior: "deny" }),
    );
    expect(fake.closeAgent).toHaveBeenCalledWith("helper-agent");
    expect(fake.deleteAgentState).toHaveBeenCalledWith("helper-agent");
    expect(fake.listeners).toHaveLength(0);
  });

  test("an abort cancels the run, rejects, and still deletes the agent", async () => {
    const fake = createFakeManager(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = runSideHelperModel({
      manager: asManager(fake),
      choice: { provider: "omp", model: "anthropic/claude-haiku-5-5" },
      cwd: "/tmp/empty",
      prompt: "question",
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(fake.runAgent).toHaveBeenCalled());
    controller.abort(new Error("took too long"));
    await expect(pending).rejects.toThrow("took too long");
    expect(fake.cancelAgentRun).toHaveBeenCalledWith("helper-agent");
    expect(fake.deleteAgentState).toHaveBeenCalledWith("helper-agent");
  });
});

test("the helper reads the current chat and the chat the question names, then logs the call", async () => {
  const fake = createFakeManager(async () => ({
    finalText: "FitUp is redesigning the food scan.",
    usage: { inputTokens: 1200, outputTokens: 20 },
  }));
  const timelines: Record<string, AgentTimelineItem[]> = {
    [RELEASE_ID]: [{ type: "assistant_message", text: "Beta 0.19 is tagged." }],
    [SCAN_ID]: [{ type: "assistant_message", text: "The scan screen now has a camera hint." }],
  };
  const loadTimeline = vi.fn(async (agentId: string) => timelines[agentId] ?? []);
  const info = vi.fn();
  const logger = pino({ level: "silent" });
  logger.info = info as unknown as typeof logger.info;
  const ask = createVoiceSideHelper({
    manager: asManager(fake),
    readChats: async () => ({ directory, agents: [] }),
    loadTimeline,
    model: () => undefined,
    scratchDir: async () => "/tmp/empty",
    logger,
  });

  const answer = await ask({
    question: "what did food scan say?",
    currentAgentId: RELEASE_ID,
    signal: new AbortController().signal,
  });

  expect(answer).toEqual({ kind: "speech", text: "FitUp is redesigning the food scan." });
  expect(loadTimeline.mock.calls.map(([id]) => id)).toEqual([RELEASE_ID, SCAN_ID]);
  const prompt = fake.runAgent.mock.calls[0] as unknown as [string, string];
  expect(prompt[1]).toContain("Beta 0.19 is tagged.");
  expect(prompt[1]).toContain("The scan screen now has a camera hint.");
  expect(prompt[1]).toContain("Question: what did food scan say?");
  expect(prompt[1]).toContain("[p1] FitUp (2 chats), [p2] Paseo (1 chat)");
  expect(prompt[1]).toContain("- [c2] FitUp / Food scan redesign");
  await vi.waitFor(() =>
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "anthropic/claude-haiku-5-5",
        inputTokens: 1200,
        outputTokens: 20,
      }),
      "Voice helper call",
    ),
  );
});

test("a proposed action comes back resolved and read back; the model never runs it", async () => {
  const fake = createFakeManager(async () => ({
    finalText:
      '{"type":"send_message","chat":"c2","target":"food scan","text":"Add a camera hint."}',
    usage: { inputTokens: 900, outputTokens: 30 },
  }));
  const info = vi.fn();
  const logger = pino({ level: "silent" });
  logger.info = info as unknown as typeof logger.info;
  const ask = createVoiceSideHelper({
    manager: asManager(fake),
    readChats: async () => ({ directory, agents: [] }),
    loadTimeline: async () => [],
    model: () => undefined,
    scratchDir: async () => "/tmp/empty",
    logger,
  });

  const reply = await ask({
    question: "tell food scan to add a camera hint",
    currentAgentId: RELEASE_ID,
    signal: new AbortController().signal,
  });

  expect(reply).toMatchObject({
    kind: "confirm",
    action: { type: "send_message", agentId: SCAN_ID, text: "Add a camera hint." },
    readBack: "Send to FitUp, Food scan redesign: Add a camera hint. Okay?",
  });
  await vi.waitFor(() =>
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ reply: "send_message" }),
      "Voice helper call",
    ),
  );
});
