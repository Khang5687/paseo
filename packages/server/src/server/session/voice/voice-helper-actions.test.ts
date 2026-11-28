import pino from "pino";
import { describe, expect, test, vi } from "vitest";

import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import type { VoiceChatProject } from "./voice-chat-directory.js";
import {
  classifyConfirmation,
  parseHelperReply,
  resolveHelperProposal,
  runVoiceHelperAction,
  spokenExcerpt,
  type HelperAgentState,
  type HelperProposal,
  type HelperWorld,
  type SideHelperReply,
} from "./voice-helper-actions.js";

describe("classifyConfirmation", () => {
  test.each([
    "Yes.",
    "Yeah.",
    "Yep!",
    "Sure.",
    "Go ahead.",
    "Do it.",
    "Sounds good.",
    "Affirmative.",
    "Okay, send it.",
    "OK",
    "Yeah, go ahead, please.",
    "ừ",
    "Được.",
    "Được rồi",
    "Ok đi",
    "Yeah go ahead",
    "Sure, send it.",
    "Yep, that's right.",
    "Yes please, send it now.",
    "Sure thing.",
    "That works.",
    "Let's do it.",
    "Go on.",
    "Fine, do that.",
    "Ừ, gửi luôn nhé",
    "Chuẩn rồi em",
  ])("%j is a yes", (reply) => {
    expect(classifyConfirmation(reply, ["send"])).toBe("yes");
  });

  test.each([
    "No.",
    "Nope.",
    "Wait.",
    "Cancel.",
    "Not that.",
    "No, wait.",
    "Don't send it.",
    "Never mind.",
    "Không.",
    "Thôi.",
    "Đừng",
    "Not now.",
    "Don't do that.",
  ])("%j is a no", (reply) => {
    expect(classifyConfirmation(reply, ["send"])).toBe("no");
  });

  test.each([
    "",
    "Hmm, I'm not sure.",
    "Yes, and also add the tests.",
    "Yes no.",
    "Okay, no.",
    "Run the tests in the other chat instead.",
    "Please.",
    "Yeah but change it to tomorrow.",
    "Don't go ahead.",
    "Send it to the other chat.",
    "Go ahead and also stop the build.",
  ])("%j is unclear", (reply) => {
    expect(classifyConfirmation(reply, ["send"])).toBe("unclear");
  });

  test("an action's own verb counts as yes for that action only", () => {
    expect(classifyConfirmation("Yes, stop it.", ["stop"])).toBe("yes");
    expect(classifyConfirmation("Stop it.", ["send"])).toBe("unclear");
    expect(classifyConfirmation("Don't stop it.", ["stop"])).toBe("no");
  });

  test("Vietnamese marks are kept: đúng is a yes, đừng a no", () => {
    expect(classifyConfirmation("Đúng rồi")).toBe("yes");
    expect(classifyConfirmation("Đừng")).toBe("no");
  });
});

describe("parseHelperReply", () => {
  test("an answer, an action, a fenced action, plain prose and broken JSON", () => {
    expect(parseHelperReply('{"type":"answer","text":"Two chats wait."}')).toEqual({
      kind: "answer",
      text: "Two chats wait.",
    });
    expect(
      parseHelperReply('```json\n{"type":"stop_run","chat":"c2","target":"food scan"}\n```'),
    ).toEqual({
      kind: "action",
      proposal: { type: "stop_run", chat: "c2", target: "food scan" },
    });
    expect(parseHelperReply("Nothing waits on you.")).toEqual({
      kind: "answer",
      text: "Nothing waits on you.",
    });
    expect(parseHelperReply('{"type":"send_message","chat":"c1"}')).toEqual({ kind: "invalid" });
    expect(parseHelperReply('{"type":"delete_files"}')).toEqual({ kind: "invalid" });
    expect(parseHelperReply("{not json")).toEqual({ kind: "invalid" });
  });
});

const MAIN_ID = "11111111-1111-4111-8111-111111111111";
const SCAN_ID = "22222222-2222-4222-8222-222222222222";
const RELEASE_ID = "33333333-3333-4333-8333-333333333333";

const directory: VoiceChatProject[] = [
  {
    projectId: "fitup",
    name: "FitUp",
    chats: [
      { agentId: SCAN_ID, workspaceId: "w-fitup", title: "Food scan redesign", lastActiveAt: 3 },
      { agentId: MAIN_ID, workspaceId: "w-fitup", title: "Main chat", lastActiveAt: 2 },
    ],
  },
  {
    projectId: "paseo",
    name: "Paseo",
    chats: [
      { agentId: RELEASE_ID, workspaceId: "w-paseo", title: "Release beta", lastActiveAt: 1 },
    ],
  },
  { projectId: "notes", name: "Notes", chats: [] },
];

function agent(id: string, extra: Partial<HelperAgentState> = {}): HelperAgentState {
  return {
    id,
    status: "idle",
    provider: "omp",
    model: "anthropic/claude-opus-5-5",
    cwd: `/work/${id}`,
    workspaceId: id === RELEASE_ID ? "w-paseo" : "w-fitup",
    currentModeId: "ask",
    thinkingOptionId: null,
    pendingPermissions: [],
    ...extra,
  };
}

function world(agents: HelperAgentState[] = []): HelperWorld {
  const byId = new Map(agents.map((entry) => [entry.id, entry]));
  return {
    directory,
    agents: [MAIN_ID, SCAN_ID, RELEASE_ID].map((id) => byId.get(id) ?? agent(id)),
    workspaces: [
      { workspaceId: "w-fitup", projectId: "fitup", cwd: "/work/fitup" },
      { workspaceId: "w-notes", projectId: "notes", cwd: "/work/notes" },
    ],
    currentAgentId: RELEASE_ID,
  };
}

function expectConfirm(reply: SideHelperReply): Extract<SideHelperReply, { kind: "confirm" }> {
  if (reply.kind !== "confirm")
    throw new Error(`expected a read-back, got ${JSON.stringify(reply)}`);
  return reply;
}

describe("resolveHelperProposal", () => {
  test("a send reads back the chat and the message, cut at 25 words; the whole text is sent", () => {
    const long = `Run the tests ${"and then check again ".repeat(8)}now.`;
    const reply = expectConfirm(
      resolveHelperProposal(
        { type: "send_message", chat: "c1", target: "fitup food scan chat", text: long },
        world(),
      ),
    );
    expect(reply.action).toEqual({ type: "send_message", agentId: SCAN_ID, text: long });
    expect(reply.readBack).toBe(`Send to FitUp, Food scan redesign: ${spokenExcerpt(long)}. Okay?`);
    expect(reply.readBack).toContain("...");
    expect(reply.askAgain).toBe("Should I send it? Say yes or no.");
  });

  test("the owner's words win over a wrong ref; a ref alone names the chat", () => {
    const named = expectConfirm(
      resolveHelperProposal(
        { type: "send_message", chat: "c3", target: "main chat", text: "Ship it." },
        world(),
      ),
    );
    expect(named.action).toMatchObject({ agentId: MAIN_ID });
    const byRef = expectConfirm(
      resolveHelperProposal(
        { type: "send_message", chat: "c3", target: "the chat waiting on me", text: "Ship it." },
        world(),
      ),
    );
    expect(byRef.action).toMatchObject({ agentId: RELEASE_ID });
  });

  test("an unknown chat is said, and a project with several chats asks which one", () => {
    expect(
      resolveHelperProposal(
        { type: "send_message", chat: null, target: "billing service", text: "Hi." },
        world(),
      ),
    ).toEqual({ kind: "speech", text: "No chat called that." });
    expect(
      resolveHelperProposal({ type: "send_message", chat: "c9", target: "", text: "Hi." }, world()),
    ).toEqual({ kind: "speech", text: "No chat called that." });

    const pick = resolveHelperProposal(
      { type: "send_message", chat: null, target: "fitup", text: "Run the tests." },
      world(),
    );
    if (pick.kind !== "pick") throw new Error("expected a pick");
    expect(pick.speech).toBe("Which FitUp chat? Food scan redesign, Main chat.");
    expect(pick.chats.map((chat) => chat.agentId)).toEqual([SCAN_ID, MAIN_ID]);
    const picked = expectConfirm(pick.resume(MAIN_ID));
    expect(picked.readBack).toBe("Send to FitUp, Main chat: Run the tests. Okay?");

    // A ref inside the named project settles it without asking.
    const settled = expectConfirm(
      resolveHelperProposal(
        { type: "send_message", chat: "c2", target: "fitup", text: "Run the tests." },
        world(),
      ),
    );
    expect(settled.action).toMatchObject({ agentId: MAIN_ID });
  });

  test("a stop needs a running chat", () => {
    const stop: HelperProposal = { type: "stop_run", chat: "c3", target: "release beta" };
    expect(resolveHelperProposal(stop, world())).toEqual({
      kind: "speech",
      text: "Paseo, Release beta is not running.",
    });
    const reply = expectConfirm(
      resolveHelperProposal(stop, world([agent(RELEASE_ID, { status: "running" })])),
    );
    expect(reply.action).toEqual({ type: "stop_run", agentId: RELEASE_ID });
    expect(reply.readBack).toBe("Stop Paseo, Release beta. Okay?");
    expect(reply.yesWords).toEqual(["stop"]);
  });

  const shellPermission: AgentPermissionRequest = {
    id: "perm-1",
    provider: "omp",
    name: "bash",
    kind: "tool",
    title: "Allow tool: bash",
    detail: { type: "shell", command: "npm test -- --bail" },
  };

  test("an approval reads back the exact command and approves only what was asked", () => {
    const approve = expectConfirm(
      resolveHelperProposal(
        { type: "answer_prompt", chat: null, target: "release beta", answer: "approve" },
        world([agent(RELEASE_ID, { pendingPermissions: [shellPermission] })]),
      ),
    );
    expect(approve.readBack).toBe(
      "Approve in Paseo, Release beta: bash, npm test -- --bail. Okay?",
    );
    expect(approve.action).toEqual({
      type: "answer_prompt",
      agentId: RELEASE_ID,
      requestId: "perm-1",
      permission: true,
      response: { behavior: "allow" },
    });
    expect(approve.askAgain).toBe("Should I approve it? Say yes or no.");

    const deny = expectConfirm(
      resolveHelperProposal(
        { type: "answer_prompt", chat: "c3", target: "", answer: "deny it" },
        world([agent(RELEASE_ID, { pendingPermissions: [shellPermission] })]),
      ),
    );
    expect(deny.action).toMatchObject({ response: { behavior: "deny" } });
    expect(
      resolveHelperProposal(
        { type: "answer_prompt", chat: "c3", target: "", answer: "hmm" },
        world([agent(RELEASE_ID, { pendingPermissions: [shellPermission] })]),
      ),
    ).toEqual({ kind: "speech", text: "Should I approve or deny it? Ask me again." });
    expect(
      resolveHelperProposal(
        { type: "answer_prompt", chat: "c3", target: "", answer: "approve" },
        world(),
      ),
    ).toEqual({ kind: "speech", text: "Paseo, Release beta has nothing waiting on you." });
  });

  test("a plan approval presses the primary button of that kind", () => {
    const plan: AgentPermissionRequest = {
      id: "plan-1",
      provider: "claude",
      name: "ExitPlanMode",
      kind: "plan",
      title: "Plan ready",
      actions: [
        { id: "reject", label: "Reject", behavior: "deny" },
        { id: "implement", label: "Implement", behavior: "allow", variant: "primary" },
        { id: "implement-resume", label: "Implement and resume", behavior: "allow" },
      ],
    };
    const reply = expectConfirm(
      resolveHelperProposal(
        { type: "answer_prompt", chat: "c3", target: "", answer: "approve" },
        world([agent(RELEASE_ID, { pendingPermissions: [plan] })]),
      ),
    );
    expect(reply.action).toMatchObject({
      response: { behavior: "allow", selectedActionId: "implement" },
    });
    expect(reply.readBack).toBe("Approve (Implement) in Paseo, Release beta: Plan ready. Okay?");
  });

  test("a question box answer must match an option", () => {
    const question: AgentPermissionRequest = {
      id: "q-1",
      provider: "omp",
      name: "ask",
      kind: "question",
      input: {
        questions: [
          {
            question: "Which cache?",
            header: "Cache",
            options: [{ label: "Redis" }, { label: "In memory" }],
          },
        ],
      },
    };
    const state = world([agent(SCAN_ID, { pendingPermissions: [question] })]);
    const reply = expectConfirm(
      resolveHelperProposal(
        { type: "answer_prompt", chat: "c1", target: "food scan", answer: "go with redis" },
        state,
      ),
    );
    expect(reply.readBack).toBe("Answer FitUp, Food scan redesign: Redis. Okay?");
    expect(reply.action).toMatchObject({
      permission: false,
      response: { behavior: "allow", updatedInput: { answers: { Cache: "Redis" } } },
    });
    expect(
      resolveHelperProposal(
        { type: "answer_prompt", chat: "c1", target: "food scan", answer: "postgres" },
        state,
      ),
    ).toEqual({ kind: "speech", text: "That's not one of the options. Redis. In memory." });
  });

  test("a new chat starts like the project's newest chat, or like the newest chat anywhere", () => {
    const fitup = expectConfirm(
      resolveHelperProposal(
        { type: "start_chat", project: null, target: "fit up", text: "Plan the onboarding flow." },
        world(),
      ),
    );
    expect(fitup.action).toEqual({
      type: "start_chat",
      projectId: "fitup",
      workspaceId: "w-fitup",
      cwd: `/work/${SCAN_ID}`,
      provider: "omp",
      model: "anthropic/claude-opus-5-5",
      modeId: "ask",
      thinkingOptionId: null,
      text: "Plan the onboarding flow.",
    });
    expect(fitup.readBack).toBe(
      "Start a chat in FitUp with Oh My Pi, claude opus 5.5: Plan the onboarding flow. Okay?",
    );

    const notes = expectConfirm(
      resolveHelperProposal(
        { type: "start_chat", project: "p3", target: "", text: "Sum up today." },
        world(),
      ),
    );
    expect(notes.action).toMatchObject({
      projectId: "notes",
      workspaceId: "w-notes",
      cwd: "/work/notes",
      provider: "omp",
    });
    expect(
      resolveHelperProposal(
        { type: "start_chat", project: null, target: "billing", text: "Hi." },
        world(),
      ),
    ).toEqual({ kind: "speech", text: "No project called that." });
  });
});

describe("runVoiceHelperAction", () => {
  test("runs the action, says how it went and logs it without the text", async () => {
    const info = vi.fn();
    const logger = pino({ level: "silent" });
    logger.info = info as unknown as typeof logger.info;
    const deps = {
      sendMessage: vi.fn(async () => {}),
      respondToPermission: vi.fn(async () => {}),
      startChat: vi.fn(async () => {}),
      stopRun: vi.fn(async () => {}),
      logger,
    };
    await expect(
      runVoiceHelperAction(
        { type: "send_message", agentId: SCAN_ID, text: "Run the tests." },
        deps,
      ),
    ).resolves.toBe("Sent.");
    expect(deps.sendMessage).toHaveBeenCalledWith(SCAN_ID, "Run the tests.");
    expect(info).toHaveBeenCalledWith(
      { action: "send_message", agentId: SCAN_ID, textLength: 14 },
      "Voice helper action",
    );
    await expect(
      runVoiceHelperAction(
        {
          type: "answer_prompt",
          agentId: RELEASE_ID,
          requestId: "perm-1",
          permission: true,
          response: { behavior: "deny", message: "Denied by user" },
        },
        deps,
      ),
    ).resolves.toBe("Denied.");
    deps.stopRun.mockRejectedValueOnce(new Error("gone"));
    await expect(
      runVoiceHelperAction({ type: "stop_run", agentId: RELEASE_ID }, deps),
    ).rejects.toThrow("gone");
  });
});
