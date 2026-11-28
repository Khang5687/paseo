// "Paseo, ..." side questions. An utterance that starts with the name goes to a one-shot model
// that answers by voice from this daemon's chat data; everything else still goes to the chat.
// Read-only: the model gets a text block of chat data and no way to change anything. An action
// (send to a chat, answer a card) would be a new step behind a spoken "yes", added here later.

import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import { getAgentProviderDefinition } from "@getpaseo/protocol/provider-manifest";
import type pino from "pino";

import { curateAgentActivity } from "../../agent/activity-curator.js";
import type { AgentManager } from "../../agent/agent-manager.js";
import type { AgentRunResult, AgentTimelineItem, AgentUsage } from "../../agent/agent-sdk-types.js";
import { selectItemsByProjectedLimit } from "../../agent/timeline-projection.js";
import type { VoiceChat, VoiceChatProject } from "@getpaseo/protocol/voice/chat-directory";
import { similarity, spokenNameScore, wordsOf } from "@getpaseo/protocol/voice/chat-match";
import type { VoiceChatTarget } from "./voice-navigate.js";

/** Provisional (owner question Q226): Haiku through OMP, the provider that works on every host. */
export const DEFAULT_SIDE_HELPER_MODEL = "omp/anthropic/claude-haiku-5-5";
/** Cap on the chat data sent with a question, in tokens (estimated as 4 characters each). */
export const SIDE_HELPER_CONTEXT_TOKENS = 6000;
const CHARS_PER_TOKEN = 4;
/** Share of the cap the chat timelines may use; the chat list gets the rest. */
const TIMELINE_SHARE = 0.6;
/** Timeline items read per chat, newest last. */
const TIMELINE_ITEMS = 12;
/** Longest single timeline entry, in characters. */
const TIMELINE_ENTRY_CHARS = 600;
/** Chats named in the question whose timeline is read, besides the current chat. */
const NAMED_CHAT_LIMIT = 2;
/** Spoken words needed to name a chat or project in a question. */
const NAMED_CHAT_THRESHOLD = 0.85;
/** How well the first words must sound like "Paseo" (0..1), after `soundsLike`. */
const NAME_THRESHOLD = 0.8;

export const SIDE_HELPER_WAIT_SPEECH = "One sec.";
export const SIDE_HELPER_FAILED_SPEECH = "Sorry, no answer.";
export const SIDE_HELPER_WAKE_SPEECH = "Yes?";
/** "One sec." plays when the answer takes longer than this. */
export const SIDE_HELPER_WAIT_MS = 1500;
/** The whole answer, chat data and model call, must arrive within this. */
export const SIDE_HELPER_TIMEOUT_MS = 20_000;

/**
 * Letters as they sound, so the spellings STT gives the name ("Paceo", "Pacio", "Pasio",
 * "Pass say oh") all come out close to "paseo": soft c and z read as s, i and y as e, h is
 * silent, and double letters count once.
 */
function soundsLike(letters: string): string {
  return letters
    .replace(/[cz]/g, "s")
    .replace(/[iy]/g, "e")
    .replace(/h/g, "")
    .replace(/(.)\1+/g, "$1");
}

const PASEO_SOUND = soundsLike("paseo");
const LEAD_WORDS = new Set(["hey", "ok", "okay"]);
/** Punctuation STT writes for the pause after a name: "Paceo, what's going on?" */
const PAUSE_MARK = /^\s*[,.!?:;\u2026\u2013\u2014-]/;

export type SideHelperCall =
  /** "Paseo, <question>". */
  | { kind: "question"; question: string }
  /** "Paseo." alone: the question comes in the next utterance. */
  | { kind: "wake" };

/**
 * Reads "Paseo, ..." at the start of an utterance. The name must be followed by a pause, which
 * STT writes as punctuation ("Paceo, which chats are waiting on me?"), so talk about the app
 * ("Paseo app crashes on start") and the name later in a sentence stay talk for the chat.
 */
export function parseSideHelperCall(transcript: string): SideHelperCall | null {
  const words = [...transcript.matchAll(/[\p{L}\p{N}'\u2019]+/gu)];
  let first = 0;
  if (words.length > 1 && LEAD_WORDS.has(plainLetters(words[0][0]))) first = 1;
  // "Pass say oh": the name may come out as up to three words.
  for (let count = 1; count <= 3 && first + count <= words.length; count += 1) {
    const nameWords = words.slice(first, first + count);
    const letters = nameWords.map((word) => plainLetters(word[0])).join("");
    if (similarity(soundsLike(letters), PASEO_SOUND) < NAME_THRESHOLD) continue;
    const last = nameWords[nameWords.length - 1];
    const rest = transcript.slice((last.index ?? 0) + last[0].length);
    if (!rest.trim()) return { kind: "wake" };
    if (!PAUSE_MARK.test(rest)) return null;
    const question = rest.replace(/^[\s,.!?:;\u2026\u2013\u2014-]+/, "").trim();
    return question ? { kind: "question", question } : { kind: "wake" };
  }
  return null;
}

function plainLetters(word: string): string {
  return word
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

const QUESTION_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "any",
  "are",
  "chat",
  "chats",
  "did",
  "do",
  "does",
  "for",
  "from",
  "going",
  "how",
  "in",
  "is",
  "it",
  "just",
  "last",
  "me",
  "my",
  "of",
  "on",
  "read",
  "say",
  "tell",
  "the",
  "to",
  "was",
  "what",
  "whats",
  "which",
  "who",
  "with",
]);

/**
 * Chats the question names, best first: a project name gives its newest chat, a chat title (or a
 * run of its words, "food scan") gives that chat. Short words and question words never name one.
 */
export function findNamedChats(
  question: string,
  directory: VoiceChatProject[],
  limit = NAMED_CHAT_LIMIT,
): VoiceChatTarget[] {
  const words = wordsOf(question);
  const runs: string[][] = [];
  for (let size = 1; size <= 3; size += 1) {
    for (let start = 0; start + size <= words.length; start += 1) {
      const run = words.slice(start, start + size);
      if (run.join("").length < 4 || run.every((word) => QUESTION_STOP_WORDS.has(word))) continue;
      runs.push(run);
    }
  }
  const bestScore = (name: string) =>
    runs.reduce((best, run) => Math.max(best, spokenNameScore(run, name)), 0);
  const hits: Array<{ target: VoiceChatTarget; score: number }> = [];
  for (const project of directory) {
    const projectScore = bestScore(project.name);
    if (projectScore >= NAMED_CHAT_THRESHOLD && project.chats.length > 0) {
      hits.push({ target: { project, chat: project.chats[0] }, score: projectScore });
    }
    for (const chat of project.chats) {
      const score = bestScore(chat.title ?? "");
      if (score >= NAMED_CHAT_THRESHOLD) hits.push({ target: { project, chat }, score });
    }
  }
  // Stable sort keeps a project's hit ahead of a chat hit with the same score.
  hits.sort((left, right) => right.score - left.score);
  const seen = new Set<string>();
  const named: VoiceChatTarget[] = [];
  for (const hit of hits) {
    if (seen.has(hit.target.chat.agentId)) continue;
    seen.add(hit.target.chat.agentId);
    named.push(hit.target);
    if (named.length >= limit) break;
  }
  return named;
}

/** What the helper is told about one chat in the list. */
export interface SideHelperChatInfo {
  agentId: string;
  projectName: string;
  title: string | null;
  status: string;
  /** Why the chat waits on the owner, or null. */
  waiting: string | null;
  lastActiveAt: number;
}

/** The fields of an agent snapshot the chat list reads. */
export interface SideHelperAgentState {
  id: string;
  status: string;
  requiresAttention?: boolean;
  attentionReason?: "finished" | "error" | "permission" | null;
  openQuestions?: Array<{ label: string | null; title: string }>;
  pendingPermissions: Array<Pick<AgentPermissionRequest, "kind" | "name" | "title">>;
}

function waitingReason(agent: SideHelperAgentState): string | null {
  const reasons: string[] = [];
  for (const request of agent.pendingPermissions) {
    const what = request.title ?? request.name;
    reasons.push(request.kind === "question" ? `question box: ${what}` : `approval: ${what}`);
  }
  for (const question of agent.openQuestions ?? []) {
    reasons.push(`asked ${question.label ? `${question.label} ` : ""}${question.title}`);
  }
  if (reasons.length === 0 && agent.requiresAttention) {
    reasons.push(agent.attentionReason === "error" ? "stopped with an error" : "finished, unread");
  }
  return reasons.length > 0 ? reasons.join("; ") : null;
}

/** The chat list for the helper: every chat voice can name, with its state. */
export function buildSideHelperChats(
  directory: VoiceChatProject[],
  agents: SideHelperAgentState[],
): SideHelperChatInfo[] {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const chats: SideHelperChatInfo[] = [];
  for (const project of directory) {
    for (const chat of project.chats) {
      const agent = byId.get(chat.agentId);
      chats.push({
        agentId: chat.agentId,
        projectName: project.name,
        title: chat.title,
        status: agent?.status ?? "unknown",
        waiting: agent ? waitingReason(agent) : null,
        lastActiveAt: chat.lastActiveAt,
      });
    }
  }
  return chats;
}

/** One chat's recent messages, as plain text. */
export interface SideHelperTimeline {
  projectName: string;
  title: string | null;
  isCurrent: boolean;
  text: string;
}

/** The last messages of a chat, oldest first, each entry cut to a few hundred characters. */
export function curateSideHelperTimeline(timeline: readonly AgentTimelineItem[]): string {
  const { items } = selectItemsByProjectedLimit({
    items: timeline,
    direction: "tail",
    limit: TIMELINE_ITEMS,
  });
  return curateAgentActivity(items, {
    labelAssistantMessages: true,
    includeKinds: ["user_message", "assistant_message", "tool_call", "error"],
  })
    .split("\n")
    .map((line) =>
      line.length > TIMELINE_ENTRY_CHARS ? `${line.slice(0, TIMELINE_ENTRY_CHARS)}...` : line,
    )
    .join("\n");
}

function ago(now: number, time: number): string {
  const minutes = Math.max(0, Math.round((now - time) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function chatLine(chat: SideHelperChatInfo, now: number, currentAgentId: string | null): string {
  const parts = [
    `${chat.projectName} / ${chat.title?.trim() || "untitled chat"}`,
    chat.status,
    `last active ${ago(now, chat.lastActiveAt)}`,
  ];
  if (chat.waiting) parts.push(`waiting on you: ${chat.waiting}`);
  if (chat.agentId === currentAgentId) parts.push("this is the chat voice is in");
  return `- ${parts.join(" | ")}`;
}

/** Keeps the end of `text` (the newest messages) within `chars`. */
function keepTail(text: string, chars: number): string {
  if (text.length <= chars) return text;
  return `[earlier messages cut]\n${text.slice(text.length - chars)}`;
}

/**
 * The chat data block sent with a question, at most `maxTokens`. Timelines come first and keep
 * their newest messages; the chat list puts the current chat and chats waiting on the owner
 * first, then the newest, and says how many it left out.
 */
export function buildSideHelperContext(
  input: {
    now: number;
    currentAgentId: string | null;
    chats: SideHelperChatInfo[];
    timelines: SideHelperTimeline[];
  },
  maxTokens = SIDE_HELPER_CONTEXT_TOKENS,
): string {
  const budget = maxTokens * CHARS_PER_TOKEN;
  const sections: string[] = [];
  let used = 0;

  const timelineBudget = Math.floor(budget * TIMELINE_SHARE);
  const perTimeline =
    input.timelines.length > 0 ? Math.floor(timelineBudget / input.timelines.length) : 0;
  for (const timeline of input.timelines) {
    const heading = `## Recent messages in ${timeline.projectName} / ${
      timeline.title?.trim() || "untitled chat"
    }${timeline.isCurrent ? " (the chat voice is in)" : ""}`;
    const body = keepTail(timeline.text, Math.max(0, perTimeline - heading.length - 1));
    const section = `${heading}\n${body}`;
    sections.push(section);
    used += section.length + 2;
  }

  const rank = (chat: SideHelperChatInfo) => {
    if (chat.agentId === input.currentAgentId) return 0;
    return chat.waiting ? 1 : 2;
  };
  const ordered = [...input.chats].sort(
    (left, right) => rank(left) - rank(right) || right.lastActiveAt - left.lastActiveAt,
  );
  const heading = `## Chats (${input.chats.length})`;
  const lines: string[] = [];
  let listUsed = used + heading.length + 1;
  // Room for the "N more" line.
  const listBudget = budget - 40;
  for (const chat of ordered) {
    const line = chatLine(chat, input.now, input.currentAgentId);
    if (listUsed + line.length + 1 > listBudget) break;
    lines.push(line);
    listUsed += line.length + 1;
  }
  const leftOut = ordered.length - lines.length;
  if (leftOut > 0) lines.push(`- and ${leftOut} more chats not listed`);
  if (lines.length === 0) lines.push("- no chats");
  sections.push(`${heading}\n${lines.join("\n")}`);
  return sections.join("\n\n");
}

/** The helper's whole system prompt: the provider adds no coding prompt, tools or context files. */
export const SIDE_HELPER_SYSTEM_PROMPT = [
  "You are Paseo's voice helper. The owner talks to his coding agents hands-free and hears your answer through text-to-speech.",
  "Answer only from the chat data in the message. If it does not say, say you don't know.",
  "Answer first, in at most three short sentences of plain spoken English. No markdown, lists, code, file paths or IDs.",
  "You can only read. If asked to do something, say you can only read for now.",
].join("\n");

export function buildSideHelperPrompt(question: string, context: string): string {
  return ["<chat-data>", context, "</chat-data>", "", `Question: ${question}`].join("\n");
}

export interface SideHelperModelChoice {
  provider: string;
  model: string;
}

/** "omp/anthropic/claude-haiku-5-5": the provider, then that provider's model id. */
export function parseSideHelperModel(value: string | null | undefined): SideHelperModelChoice {
  const text = value?.trim() || DEFAULT_SIDE_HELPER_MODEL;
  const slash = text.indexOf("/");
  if (slash <= 0 || slash === text.length - 1) {
    return parseSideHelperModel(DEFAULT_SIDE_HELPER_MODEL);
  }
  return { provider: text.slice(0, slash), model: text.slice(slash + 1) };
}

/** The provider's safest mode (approval for every write and command), when it has one. */
function safeModeId(provider: string): string | undefined {
  try {
    return getAgentProviderDefinition(provider).modes.find((mode) => mode.colorTier === "safe")?.id;
  } catch {
    return undefined;
  }
}

const DENIED_MESSAGE =
  "You are a read-only voice helper. Answer from the chat data you were given.";

type OneShotManager = Pick<
  AgentManager,
  | "createAgent"
  | "runAgent"
  | "cancelAgentRun"
  | "closeAgent"
  | "deleteAgentState"
  | "subscribe"
  | "respondToPermission"
>;

export interface SideHelperAnswer {
  text: string;
  /**
   * The call's token use, once the hidden agent is closed and deleted. OMP reports usage after
   * the turn ends, so the answer is spoken without waiting for it.
   */
  usage: Promise<AgentUsage | undefined>;
}

/** How long to wait after the turn for a provider that reports usage late (OMP). */
const FINAL_USAGE_WAIT_MS = 2000;

/**
 * One question, one model turn, on a hidden agent that is closed and deleted afterwards. It runs
 * toolless (no tools, no skills, rules or context files, only `SIDE_HELPER_SYSTEM_PROMPT`) in an
 * empty folder in the provider's safest mode, and every approval it asks for is denied, the same
 * guard `ask_agent` copies use, for a provider that cannot run toolless. Aborting `signal`
 * cancels the run.
 */
export async function runSideHelperModel(input: {
  manager: OneShotManager;
  choice: SideHelperModelChoice;
  cwd: string;
  prompt: string;
  signal: AbortSignal;
}): Promise<SideHelperAnswer> {
  const { manager, choice, signal } = input;
  signal.throwIfAborted();
  const modeId = safeModeId(choice.provider);
  const agent = await manager.createAgent(
    {
      provider: choice.provider,
      model: choice.model,
      cwd: input.cwd,
      internal: true,
      title: "Voice helper",
      systemPrompt: SIDE_HELPER_SYSTEM_PROMPT,
      ...(modeId ? { modeId } : {}),
    },
    undefined,
    { persistSession: false, workspaceId: undefined, toolless: true },
  );
  let streamedUsage: AgentUsage | undefined;
  let onLateUsage: (() => void) | null = null;
  const unsubscribe = manager.subscribe(
    (event) => {
      if (event.type !== "agent_stream") return;
      if (event.event.type === "usage_updated") {
        streamedUsage = { ...streamedUsage, ...event.event.usage };
        onLateUsage?.();
      } else if (event.event.type === "permission_requested") {
        manager
          .respondToPermission(agent.id, event.event.request.id, {
            behavior: "deny",
            message: DENIED_MESSAGE,
          })
          .catch(() => undefined);
      }
    },
    { agentId: agent.id, includeInternal: true, replayState: false },
  );
  const dispose = async () => {
    unsubscribe();
    await manager.closeAgent(agent.id).catch(() => undefined);
    await manager.deleteAgentState(agent.id).catch(() => undefined);
  };
  let result: AgentRunResult;
  try {
    const run = manager.runAgent(agent.id, input.prompt);
    result = await raceAbort(run, signal, () => manager.cancelAgentRun(agent.id));
  } catch (error) {
    await dispose();
    throw error;
  }
  const usage = (async () => {
    if (!result.usage) {
      await new Promise<void>((resolve) => {
        onLateUsage = resolve;
        setTimeout(resolve, FINAL_USAGE_WAIT_MS);
      });
    }
    await dispose();
    return result.usage ?? streamedUsage;
  })();
  return { text: result.finalText.trim(), usage };
}

async function raceAbort<T>(
  run: Promise<T>,
  signal: AbortSignal,
  cancel: () => Promise<unknown>,
): Promise<T> {
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    // Aborted while the hidden agent was being created.
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([run, aborted]);
  } catch (error) {
    await cancel().catch(() => undefined);
    run.catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export interface VoiceSideHelperDeps {
  manager: OneShotManager;
  /** The chats voice can name, and the agent state behind them (status, waiting on you). */
  readChats(): Promise<{ directory: VoiceChatProject[]; agents: SideHelperAgentState[] }>;
  /** A chat's timeline; loads the chat's history when it is not loaded. */
  loadTimeline(agentId: string): Promise<readonly AgentTimelineItem[]>;
  /** The configured model, read at every question so a settings change applies at once. */
  model(): string | undefined;
  /** An empty folder the hidden agent starts in. */
  scratchDir(): Promise<string>;
  logger: pino.Logger;
  now?: () => number;
}

/** Answers one side question: builds the chat data, asks the model, logs the cost. */
export function createVoiceSideHelper(deps: VoiceSideHelperDeps) {
  const now = deps.now ?? Date.now;
  return async (input: {
    question: string;
    currentAgentId: string | null;
    signal: AbortSignal;
  }): Promise<string> => {
    const { directory, agents } = await deps.readChats();
    const current = input.currentAgentId
      ? directory
          .flatMap((project) => project.chats.map((chat) => ({ project, chat })))
          .find(({ chat }) => chat.agentId === input.currentAgentId)
      : undefined;
    const targets: Array<{ project: VoiceChatProject; chat: VoiceChat; isCurrent: boolean }> = [];
    if (current) targets.push({ ...current, isCurrent: true });
    for (const named of findNamedChats(input.question, directory)) {
      if (named.chat.agentId !== input.currentAgentId) targets.push({ ...named, isCurrent: false });
    }
    const timelines = await Promise.all(
      targets.map(async ({ project, chat, isCurrent }) => {
        const timeline = await deps.loadTimeline(chat.agentId).catch((error: unknown) => {
          deps.logger.warn({ err: error, agentId: chat.agentId }, "Voice helper: no timeline");
          return [];
        });
        return {
          projectName: project.name,
          title: chat.title,
          isCurrent,
          text: curateSideHelperTimeline(timeline),
        };
      }),
    );
    const context = buildSideHelperContext({
      now: now(),
      currentAgentId: input.currentAgentId,
      chats: buildSideHelperChats(directory, agents),
      timelines,
    });
    const choice = parseSideHelperModel(deps.model());
    const startedAt = now();
    const call = {
      provider: choice.provider,
      model: choice.model,
      contextTokensEstimate: Math.ceil(context.length / CHARS_PER_TOKEN),
      timelines: timelines.length,
    };
    let answer: SideHelperAnswer;
    try {
      answer = await runSideHelperModel({
        manager: deps.manager,
        choice,
        cwd: await deps.scratchDir(),
        prompt: buildSideHelperPrompt(input.question, context),
        signal: input.signal,
      });
    } catch (error) {
      deps.logger.warn(
        { ...call, err: error, durationMs: now() - startedAt },
        "Voice helper call failed",
      );
      throw error;
    }
    const durationMs = now() - startedAt;
    void answer.usage.then((usage) =>
      deps.logger.info(
        {
          ...call,
          inputTokens: usage?.inputTokens ?? null,
          cachedInputTokens: usage?.cachedInputTokens ?? null,
          outputTokens: usage?.outputTokens ?? null,
          costUsd: usage?.totalCostUsd ?? null,
          durationMs,
        },
        "Voice helper call",
      ),
    );
    return answer.text;
  };
}
