// What "Paseo, ..." may do besides answering: send to a chat, answer a chat's question box or
// permission prompt, start a chat, stop a run. The model only proposes an action as JSON; the
// daemon resolves the chat, reads the action back, and runs it only after a spoken yes. The yes
// is read from fixed word lists, never by a model.

import type {
  AgentPermissionAction,
  AgentPermissionRequest,
  AgentPermissionResponse,
} from "@getpaseo/protocol/agent-types";
import type { VoiceChat, VoiceChatProject } from "@getpaseo/protocol/voice/chat-directory";
import {
  MATCH_THRESHOLD,
  resolveGoToTarget,
  spokenNameScore,
  wordsOf,
} from "@getpaseo/protocol/voice/chat-match";
import { getAgentProviderDefinition } from "@getpaseo/protocol/provider-manifest";
import type pino from "pino";
import { z } from "zod";

import { prepareTextForSpeech } from "./speech-text.js";
import { interpretSpokenAnswer, parseSpokenQuestions } from "./spoken-question.js";
import {
  SPOKEN_CHAT_LIMIT,
  spokenChatName,
  type VoiceChatTarget,
} from "./voice-navigate.js";
import type { SideHelperAgentState } from "./voice-side-helper.js";

/** Words of the message read back before it is cut with "..."; the whole text is still sent. */
export const READ_BACK_WORDS = 25;
/** Quiet after the read-back before the action is dropped. */
export const HELPER_CONFIRM_SILENCE_MS = 8000;
export const HELPER_DROPPED_SPEECH = "Okay, not doing it.";
export const HELPER_FAILED_ACTION_SPEECH = "Sorry, that didn't work.";
const PROJECT_MATCH_THRESHOLD = 0.8;

// ---------------------------------------------------------------------------------------------
// Confirmation

export type HelperConfirmation = "yes" | "no" | "unclear";

const YES_PHRASES = [
  "yes",
  "yeah",
  "yea",
  "yep",
  "yup",
  "ya",
  "sure",
  "ok",
  "okay",
  "alright",
  "all right",
  "go ahead",
  "go for it",
  "do it",
  "please do",
  "sounds good",
  "affirmative",
  "correct",
  "confirm",
  "confirmed",
  "right",
  "thats right",
  "absolutely",
  "of course",
  "perfect",
  "great",
  "uh huh",
  "mm hmm",
  "go",
  "go on",
  "lets go",
  "lets do it",
  "do that",
  "sure thing",
  "fine",
  "thats fine",
  "cool",
  "that works",
  "works for me",
  "thats correct",
  "exactly",
  "make it so",
  "ship it",
  // Vietnamese, with and without the marks STT may drop.
  "ừ",
  "ừm",
  "được",
  "được rồi",
  "duoc",
  "có",
  "vâng",
  "vang",
  "dạ",
  "đúng",
  "đúng rồi",
  "đồng ý",
  "đi",
  "ok đi",
  "gửi đi",
  "làm đi",
  "gửi luôn",
  "làm luôn",
  "chuẩn",
  "chuẩn rồi",
];

const NO_PHRASES = [
  "no",
  "nope",
  "nah",
  "negative",
  "wait",
  "hold on",
  "hang on",
  "cancel",
  "cancel it",
  "cancel that",
  "not that",
  "not now",
  "not yet",
  "dont",
  "do not",
  "dont do it",
  "do not do it",
  "dont do that",
  "do not do that",
  "never mind",
  "nevermind",
  "forget it",
  "abort",
  "không",
  "khong",
  "ko",
  "thôi",
  "thoi",
  "đừng",
  "khoan",
  "khoan đã",
  "chờ đã",
  "không phải",
  "hủy",
  "huỷ",
];

// Filler may sit around yes or no words without changing them. Vietnamese particles and
// pronouns ("ừ nhé", "được em") count as filler; "not now" stays a no (longest phrase wins).
const FILLER_PHRASES = [
  "please",
  "thanks",
  "thank you",
  "then",
  "just",
  "now",
  "oh",
  "um",
  "uh",
  "well",
  "nhé",
  "nha",
  "em",
  "anh",
];

/** Lower case words in NFC, apostrophes dropped. Vietnamese marks stay: "đúng" is yes, "đừng" no. */
function confirmationWords(text: string): string[] {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/['\u2019]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter((word) => word.length > 0);
}

/**
 * Reads the reply to a read-back. The whole reply must be made of yes words ("yeah, go
 * ahead"), or of no words ("no, wait"), plus filler ("please"); anything else, both kinds
 * at once, or silence is unclear. `actionWords` are the action's own verbs ("send", "stop"),
 * which count as yes for that action only: "stop it" confirms a stop, "don't send it" refuses.
 */
export function classifyConfirmation(
  text: string,
  actionWords: readonly string[] = [],
): HelperConfirmation {
  const words = confirmationWords(text);
  if (words.length === 0 || words.length > 8) return "unclear";
  const yes = new Set(YES_PHRASES);
  const no = new Set(NO_PHRASES);
  for (const verb of actionWords) {
    yes.add(verb);
    yes.add(`${verb} it`);
    yes.add(`ok ${verb} it`);
    no.add(`dont ${verb}`);
    no.add(`dont ${verb} it`);
    no.add(`do not ${verb} it`);
  }
  const filler = new Set(FILLER_PHRASES);
  let sawYes = false;
  let sawNo = false;
  let index = 0;
  // Longest phrase first, so "dont send it" is one no, not "dont" and "send it".
  while (index < words.length) {
    let matched = 0;
    for (let size = Math.min(4, words.length - index); size >= 1; size -= 1) {
      const phrase = words.slice(index, index + size).join(" ");
      if (yes.has(phrase)) sawYes = true;
      else if (no.has(phrase)) sawNo = true;
      else if (!filler.has(phrase)) continue;
      matched = size;
      break;
    }
    if (matched === 0) return "unclear";
    index += matched;
  }
  if (sawYes === sawNo) return "unclear";
  return sawYes ? "yes" : "no";
}

// ---------------------------------------------------------------------------------------------
// The model's reply

const ChatRefFields = {
  chat: z.string().nullable().optional(),
  target: z.string().optional(),
};

const HelperReplySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("answer"), text: z.string() }),
  z.object({ type: z.literal("send_message"), ...ChatRefFields, text: z.string() }),
  z.object({ type: z.literal("answer_prompt"), ...ChatRefFields, answer: z.string() }),
  z.object({
    type: z.literal("start_chat"),
    project: z.string().nullable().optional(),
    target: z.string().optional(),
    text: z.string(),
  }),
  z.object({ type: z.literal("stop_run"), ...ChatRefFields }),
]);

export type HelperProposal = Exclude<z.infer<typeof HelperReplySchema>, { type: "answer" }>;

export type ParsedHelperReply =
  | { kind: "answer"; text: string }
  | { kind: "action"; proposal: HelperProposal }
  | { kind: "invalid" };

/**
 * The model's reply: one JSON object (a fenced block is unwrapped). Only a reply that parses and
 * matches the schema can propose an action. Plain prose is spoken as the answer, so a model that
 * forgets the format still answers; something that looks like JSON but is not valid is dropped.
 */
export function parseHelperReply(text: string): ParsedHelperReply {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, "$1")
    .trim();
  if (!trimmed.startsWith("{")) {
    return trimmed ? { kind: "answer", text: trimmed } : { kind: "invalid" };
  }
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return { kind: "invalid" };
  }
  const parsed = HelperReplySchema.safeParse(json);
  if (!parsed.success) return { kind: "invalid" };
  if (parsed.data.type === "answer") {
    const answer = parsed.data.text.trim();
    return answer ? { kind: "answer", text: answer } : { kind: "invalid" };
  }
  return { kind: "action", proposal: parsed.data };
}

// ---------------------------------------------------------------------------------------------
// Refs the model uses to name a chat or a project

/** "c1".."cN" for chats and "p1".."pN" for projects, in directory order. */
export function chatRef(index: number): string {
  return `c${index + 1}`;
}

export function projectRef(index: number): string {
  return `p${index + 1}`;
}

function chatsByRef(directory: VoiceChatProject[]): Map<string, VoiceChatTarget> {
  const refs = new Map<string, VoiceChatTarget>();
  for (const project of directory) {
    for (const chat of project.chats) refs.set(chatRef(refs.size), { project, chat });
  }
  return refs;
}

// ---------------------------------------------------------------------------------------------
// From proposal to a confirmed action

/** An action the daemon runs once the owner said yes. */
export type VoiceHelperAction =
  | { type: "send_message"; agentId: string; text: string }
  | {
      type: "answer_prompt";
      agentId: string;
      requestId: string;
      response: AgentPermissionResponse;
      /** A permission prompt (tool, plan, mode), not a question box. */
      permission: boolean;
    }
  | {
      type: "start_chat";
      projectId: string;
      workspaceId: string;
      cwd: string;
      provider: string;
      model: string | null;
      modeId: string | null;
      thinkingOptionId: string | null;
      text: string;
    }
  | { type: "stop_run"; agentId: string };

export type SideHelperReply =
  | { kind: "speech"; text: string }
  | {
      kind: "confirm";
      action: VoiceHelperAction;
      /** "Send to FitUp, Food scan: run the tests. Okay?" */
      readBack: string;
      /** Said once when the reply is unclear: "Should I send it? Say yes or no." */
      askAgain: string;
      /** The action's verbs that also count as yes ("send it"). */
      yesWords: readonly string[];
    }
  | {
      /** The words named a project with several chats: "Which one?" */
      kind: "pick";
      speech: string;
      chats: VoiceChat[];
      resume(agentId: string): SideHelperReply;
    };

/** What a helper action needs to know about an agent, from its snapshot. */
export interface HelperAgentState extends SideHelperAgentState {
  provider?: string;
  model?: string | null;
  cwd?: string;
  workspaceId?: string;
  currentModeId?: string | null;
  thinkingOptionId?: string | null;
  pendingPermissions: AgentPermissionRequest[];
}

export interface HelperWorkspace {
  workspaceId: string;
  projectId: string;
  cwd: string;
}

export interface HelperWorld {
  directory: VoiceChatProject[];
  agents: HelperAgentState[];
  workspaces: HelperWorkspace[];
  currentAgentId: string | null;
}

/** The message as read aloud: cleaned for speech and cut at `READ_BACK_WORDS` words. */
export function spokenExcerpt(text: string, maxWords = READ_BACK_WORDS): string {
  const words = prepareTextForSpeech(text)
    .split(/\s+/)
    .filter((word) => word.length > 0);
  if (words.length <= maxWords) return words.join(" ").replace(/[.!?]+$/, "");
  return `${words.slice(0, maxWords).join(" ")}...`;
}

function spokenTarget(target: VoiceChatTarget): string {
  return `${target.project.name}, ${spokenChatName(target.chat)}`;
}

/** "omp" + "anthropic/claude-haiku-5-5" reads as "Oh My Pi, claude haiku 5.5". */
export function spokenModelName(provider: string, model: string | null): string {
  let label = provider;
  try {
    label = getAgentProviderDefinition(provider).label;
  } catch {
    // An unknown provider is read by its id.
  }
  if (!model) return label;
  const name = (model.split("/").pop() ?? model).replace(/(\d)-(?=\d)/g, "$1.").replace(/-/g, " ");
  return `${label}, ${name}`;
}

/** Words a model might keep around a chat's name: "the fitup food scan chat". */
const TARGET_FILLER = new Set(["the", "a", "chat", "chats", "in", "project", "thread", "my"]);

function targetWords(target: string | undefined): string {
  return wordsOf(target ?? "")
    .filter((word) => !TARGET_FILLER.has(word))
    .join(" ");
}

type ChatResolution =
  | { kind: "chat"; target: VoiceChatTarget }
  | { kind: "pick"; project: VoiceChatProject }
  | { kind: "speech"; text: string };

/** A chat in any project whose title the words name ("food scan"), best score first. */
function chatNamedAnywhere(words: string, directory: VoiceChatProject[]): VoiceChatTarget | null {
  const spoken = wordsOf(words);
  let best: { target: VoiceChatTarget; score: number } | null = null;
  for (const project of directory) {
    for (const chat of project.chats) {
      const score = spokenNameScore(spoken, chat.title ?? "");
      if (score >= MATCH_THRESHOLD && (!best || score > best.score)) {
        best = { target: { project, chat }, score };
      }
    }
  }
  return best?.target ?? null;
}

/**
 * The chat an action is for. The owner's words win when they name a chat outright ("fitup food
 * scan", or a chat title in any project). A project with one chat gives that chat; with several,
 * the model's ref counts only when it is one of them, else voice asks which. Without a name the
 * model's ref is used ("the chat waiting on me").
 */
function resolveChat(
  proposal: { chat?: string | null; target?: string },
  world: HelperWorld,
): ChatResolution {
  const refs = chatsByRef(world.directory);
  const refTarget = proposal.chat ? refs.get(proposal.chat.trim().toLowerCase()) : undefined;
  const words = targetWords(proposal.target);
  const currentProjectId =
    [...refs.values()].find(({ chat }) => chat.agentId === world.currentAgentId)?.project
      .projectId ?? null;
  const named = words
    ? (resolveGoToTarget(words, world.directory, currentProjectId) ??
      chatNamedAnywhere(words, world.directory))
    : null;
  if (named?.chat) return { kind: "chat", target: { project: named.project, chat: named.chat } };
  if (named) {
    const { project } = named;
    if (refTarget && refTarget.project.projectId === project.projectId) {
      return { kind: "chat", target: refTarget };
    }
    if (project.chats.length === 1)
      return { kind: "chat", target: { project, chat: project.chats[0] } };
    if (project.chats.length === 0)
      return { kind: "speech", text: `${project.name} has no chats.` };
    return { kind: "pick", project };
  }
  if (refTarget) return { kind: "chat", target: refTarget };
  return { kind: "speech", text: "No chat called that." };
}

function buildPickSpeech(project: VoiceChatProject): string {
  const names = project.chats.slice(0, SPOKEN_CHAT_LIMIT).map(spokenChatName);
  const more = project.chats.length - names.length;
  const list = more > 0 ? [...names, `and ${more} more`] : names;
  return `Which ${project.name} chat? ${list.join(", ")}.`;
}

function findTarget(world: HelperWorld, agentId: string): VoiceChatTarget | null {
  for (const project of world.directory) {
    const chat = project.chats.find((candidate) => candidate.agentId === agentId);
    if (chat) return { project, chat };
  }
  return null;
}

const APPROVE_WORDS = new Set([
  "approve",
  "approved",
  "allow",
  "allowed",
  "yes",
  "accept",
  "ok",
  "okay",
  "go",
]);
const DENY_WORDS = new Set([
  "deny",
  "denied",
  "reject",
  "rejected",
  "decline",
  "no",
  "refuse",
  "block",
]);

/** Approve or deny, from the model's answer words; null when it says neither or both. */
function readDecision(answer: string): "allow" | "deny" | null {
  const words = wordsOf(answer);
  const allow = words.some((word) => APPROVE_WORDS.has(word));
  const deny = words.some((word) => DENY_WORDS.has(word));
  if (allow === deny) return null;
  return allow ? "allow" : "deny";
}

/** The button a tap would press: the primary action of that kind, else the first one. */
function pickPermissionAction(
  actions: AgentPermissionAction[] | undefined,
  behavior: "allow" | "deny",
): AgentPermissionAction | undefined {
  const matching = (actions ?? []).filter((action) => action.behavior === behavior);
  return matching.find((action) => action.variant === "primary") ?? matching[0];
}

/** What a permission prompt asks to do, as read back: the exact command for a shell tool. */
function describePermission(request: AgentPermissionRequest): string {
  if (request.detail?.type === "shell") return `${request.name}, ${request.detail.command}`;
  const parts = [request.title?.trim() || request.name, request.description?.trim()].filter(
    (part): part is string => Boolean(part),
  );
  return parts.join(", ");
}

function confirm(
  action: VoiceHelperAction,
  readBack: string,
  verb: string,
  yesWords: readonly string[],
): SideHelperReply {
  return {
    kind: "confirm",
    action,
    readBack: `${readBack}. Okay?`,
    askAgain: `Should I ${verb} it? Say yes or no.`,
    yesWords,
  };
}

function resolveSend(
  target: VoiceChatTarget,
  proposal: Extract<HelperProposal, { type: "send_message" }>,
): SideHelperReply {
  const text = proposal.text.trim();
  if (!text) return { kind: "speech", text: "What should I send?" };
  return confirm(
    { type: "send_message", agentId: target.chat.agentId, text },
    `Send to ${spokenTarget(target)}: ${spokenExcerpt(text)}`,
    "send",
    ["send"],
  );
}

function resolveStop(
  target: VoiceChatTarget,
  agent: HelperAgentState | undefined,
): SideHelperReply {
  if (agent?.status !== "running") {
    return { kind: "speech", text: `${spokenTarget(target)} is not running.` };
  }
  return confirm(
    { type: "stop_run", agentId: target.chat.agentId },
    `Stop ${spokenTarget(target)}`,
    "stop",
    ["stop"],
  );
}

function resolveAnswer(
  target: VoiceChatTarget,
  agent: HelperAgentState | undefined,
  answer: string,
): SideHelperReply {
  const request = agent?.pendingPermissions[0];
  const where = spokenTarget(target);
  if (!request) return { kind: "speech", text: `${where} has nothing waiting on you.` };
  const base = {
    type: "answer_prompt" as const,
    agentId: target.chat.agentId,
    requestId: request.id,
  };

  if (request.kind === "question") {
    const questions = parseSpokenQuestions(request.input);
    if (!questions) return { kind: "speech", text: `I can't read the question in ${where}.` };
    if (questions.length > 1) {
      return {
        kind: "speech",
        text: `That question box has ${questions.length} questions. Answer it in the chat.`,
      };
    }
    const question = questions[0];
    const reply = interpretSpokenAnswer(question, answer);
    if (reply.kind === "answer") {
      return confirm(
        {
          ...base,
          permission: false,
          response: {
            behavior: "allow",
            updatedInput: { ...request.input, answers: { [question.header]: reply.answer } },
          },
        },
        `Answer ${where}: ${spokenExcerpt(reply.answer)}`,
        "send",
        ["send", "answer"],
      );
    }
    if (reply.kind === "dismiss") {
      return confirm(
        {
          ...base,
          permission: false,
          response: { behavior: "deny", message: "Dismissed by user" },
        },
        `Dismiss the question in ${where}`,
        "dismiss",
        ["dismiss"],
      );
    }
    return {
      kind: "speech",
      text: `That's not one of the options. ${question.options.join(". ")}.`,
    };
  }

  const decision = readDecision(answer);
  if (!decision) return { kind: "speech", text: "Should I approve or deny it? Ask me again." };
  const action = pickPermissionAction(request.actions, decision);
  const response: AgentPermissionResponse =
    decision === "allow"
      ? { behavior: "allow", ...(action ? { selectedActionId: action.id } : {}) }
      : {
          behavior: "deny",
          message: "Denied by user",
          ...(action ? { selectedActionId: action.id } : {}),
        };
  const verb = decision === "allow" ? "approve" : "deny";
  const choice =
    action && request.actions && request.actions.length > 1 ? ` (${action.label})` : "";
  return confirm(
    { ...base, permission: true, response },
    `${decision === "allow" ? "Approve" : "Deny"}${choice} in ${where}: ${spokenExcerpt(
      describePermission(request),
    )}`,
    verb,
    [verb],
  );
}

function resolveProject(
  proposal: Extract<HelperProposal, { type: "start_chat" }>,
  directory: VoiceChatProject[],
): VoiceChatProject | null {
  const words = wordsOf(targetWords(proposal.target));
  if (words.length > 0) {
    let best: { project: VoiceChatProject; score: number } | null = null;
    for (const project of directory) {
      const score = spokenNameScore(words, project.name);
      if (score >= PROJECT_MATCH_THRESHOLD && (!best || score > best.score))
        best = { project, score };
    }
    if (best) return best.project;
  }
  const ref = proposal.project?.trim().toLowerCase();
  const index = ref && /^p\d+$/.test(ref) ? Number(ref.slice(1)) - 1 : -1;
  return directory[index] ?? null;
}

/**
 * A new chat starts like the project's newest chat (provider, model, mode, folder). A project
 * with no chat starts in its workspace with the agent of the newest chat anywhere.
 */
function resolveStart(
  proposal: Extract<HelperProposal, { type: "start_chat" }>,
  world: HelperWorld,
): SideHelperReply {
  const project = resolveProject(proposal, world.directory);
  if (!project) return { kind: "speech", text: "No project called that." };
  const text = proposal.text.trim();
  if (!text) return { kind: "speech", text: "What should the new chat do?" };
  const byId = new Map(world.agents.map((agent) => [agent.id, agent]));
  const projectAgent = project.chats
    .map((chat) => byId.get(chat.agentId))
    .find((agent) => agent?.provider && agent.cwd);
  const newestAnywhere = world.directory
    .flatMap((entry) => entry.chats)
    .sort((left, right) => right.lastActiveAt - left.lastActiveAt)
    .map((chat) => byId.get(chat.agentId))
    .find((agent) => agent?.provider);
  const template = projectAgent ?? newestAnywhere;
  const workspace = projectAgent?.workspaceId
    ? { workspaceId: projectAgent.workspaceId, cwd: projectAgent.cwd! }
    : world.workspaces.find((entry) => entry.projectId === project.projectId);
  if (!template?.provider || !workspace) {
    return { kind: "speech", text: `I don't know which agent to start in ${project.name}.` };
  }
  const model = template.model ?? null;
  return confirm(
    {
      type: "start_chat",
      projectId: project.projectId,
      workspaceId: workspace.workspaceId,
      cwd: workspace.cwd,
      provider: template.provider,
      model,
      modeId: template.currentModeId ?? null,
      thinkingOptionId: template.thinkingOptionId ?? null,
      text,
    },
    `Start a chat in ${project.name} with ${spokenModelName(template.provider, model)}: ${spokenExcerpt(text)}`,
    "start",
    ["start"],
  );
}

/**
 * Turns the model's proposal into a read-back to confirm, a "which one?" or a spoken reason it
 * cannot be done. `agentId` is the chat the owner picked after "which one?".
 */
export function resolveHelperProposal(
  proposal: HelperProposal,
  world: HelperWorld,
  agentId?: string,
): SideHelperReply {
  if (proposal.type === "start_chat") return resolveStart(proposal, world);

  let target: VoiceChatTarget | null;
  if (agentId) {
    target = findTarget(world, agentId);
    if (!target) return { kind: "speech", text: "No chat called that." };
  } else {
    const resolved = resolveChat(proposal, world);
    if (resolved.kind === "speech") return resolved;
    if (resolved.kind === "pick") {
      return {
        kind: "pick",
        speech: buildPickSpeech(resolved.project),
        chats: resolved.project.chats,
        resume: (picked) => resolveHelperProposal(proposal, world, picked),
      };
    }
    target = resolved.target;
  }
  const agent = world.agents.find((candidate) => candidate.id === target.chat.agentId);
  switch (proposal.type) {
    case "send_message":
      return resolveSend(target, proposal);
    case "stop_run":
      return resolveStop(target, agent);
    case "answer_prompt":
      return resolveAnswer(target, agent, proposal.answer);
  }
}

// ---------------------------------------------------------------------------------------------
// Running a confirmed action

export interface VoiceHelperActionDeps {
  /** A typed message, joining a run in progress instead of replacing it. */
  sendMessage(agentId: string, text: string): Promise<void>;
  respondToPermission(
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<void>;
  startChat(action: Extract<VoiceHelperAction, { type: "start_chat" }>): Promise<void>;
  stopRun(agentId: string): Promise<void>;
  logger: pino.Logger;
}

/** Runs an action the owner confirmed and says what happened. Every run is logged. */
export async function runVoiceHelperAction(
  action: VoiceHelperAction,
  deps: VoiceHelperActionDeps,
): Promise<string> {
  const logged = {
    action: action.type,
    ...("agentId" in action ? { agentId: action.agentId } : { projectId: action.projectId }),
    ...("text" in action ? { textLength: action.text.length } : {}),
  };
  try {
    let speech: string;
    switch (action.type) {
      case "send_message":
        await deps.sendMessage(action.agentId, action.text);
        speech = "Sent.";
        break;
      case "answer_prompt":
        await deps.respondToPermission(action.agentId, action.requestId, action.response);
        if (!action.permission) speech = "Answered.";
        else speech = action.response.behavior === "allow" ? "Approved." : "Denied.";
        break;
      case "start_chat":
        await deps.startChat(action);
        speech = "Started.";
        break;
      case "stop_run":
        await deps.stopRun(action.agentId);
        speech = "Stopped.";
        break;
    }
    deps.logger.info(logged, "Voice helper action");
    return speech;
  } catch (error) {
    deps.logger.warn({ ...logged, err: error }, "Voice helper action failed");
    throw error;
  }
}
