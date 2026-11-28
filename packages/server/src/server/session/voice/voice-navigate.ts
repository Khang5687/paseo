// Voice commands that move live voice to another chat: "go to <project> [<chat>]",
// "list chats", "go back". Fixed English words matched on the whole utterance, no model.
// Names come from a `VoiceChatProject[]` directory; where it comes from is the caller's
// business (today the daemon's own projects), so the parser and matcher never change with it.

import { prepareTextForSpeech } from "./speech-text.js";
import { spokenOrdinalIndex } from "./spoken-question.js";
import type { VoiceChat, VoiceChatProject } from "./voice-chat-directory.js";

export type VoiceNavCommand =
  | { kind: "go_to"; target: string }
  | { kind: "list_chats" }
  | { kind: "go_back" };

/** A chat and the project it is in. */
export interface VoiceChatTarget {
  project: VoiceChatProject;
  chat: VoiceChat;
}

export interface VoiceNavTarget {
  project: VoiceChatProject;
  /** null: the project was named without a chat. */
  chat: VoiceChat | null;
}

/**
 * What voice remembers across chats on one socket. The app turns voice off and on again for
 * every move, which starts a new voice session, so this lives outside it.
 */
export interface VoiceNavMemory {
  currentAgentId: string | null;
  previousAgentId: string | null;
  /** Spoken once voice is on in `agentId`: "FitUp, main chat." */
  arrival: { agentId: string; speech: string } | null;
}

export function createVoiceNavMemory(): VoiceNavMemory {
  return { currentAgentId: null, previousAgentId: null, arrival: null };
}
/** How many chat names are read aloud before "and N more". */
export const SPOKEN_CHAT_LIMIT = 5;
/** Longest chat title read aloud, in words. */
const SPOKEN_TITLE_WORDS = 6;
/** Most words a "go to" target may have; longer is a sentence for the agent. */
const MAX_TARGET_WORDS = 8;
/** Similarity a spoken name needs to count as naming a project or chat (0..1). */
const MATCH_THRESHOLD = 0.8;
/** A part of a longer name scores a little under the same whole name. */
const PART_MATCH_FACTOR = 0.95;

export const NO_CHAT_SPEECH = "No chat called that.";
export const NO_PREVIOUS_CHAT_SPEECH = "No previous chat.";

const NUMBER_WORDS: Record<string, string> = {
  zero: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
  eleven: "11",
  twelve: "12",
};

/** Lower case words without accents, punctuation or emoji; number words become digits. */
function wordsOf(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/['\u2019]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter((word) => word.length > 0)
    .map((word) => NUMBER_WORDS[word] ?? word);
}

const LEAD_WORDS = /^(?:(?:ok|okay|hey|please|now|and|so) )+/;
const TRAIL_WORDS = /(?: (?:please|now|over))+$/;
const GO_TO = /^(?:go|switch|jump|take me) to (?:the )?(.+)$/;
const LIST_CHATS =
  /^(?:list|show|which|what)(?: are)?(?: the| my| all)?(?: the)? chats?(?: are (?:there|open)| do i have| in this project)?$/;
const GO_BACK = /^go back(?: to the (?:last|previous) (?:chat|one))?$/;

/**
 * Reads a whole utterance as a navigation command, or null for anything else. "Go to the auth
 * module and add logging" parses as a go-to; it becomes a command only when its target names a
 * project or chat (see `resolveGoToTarget`), otherwise it is talk for the agent.
 */
export function parseVoiceNavCommand(transcript: string): VoiceNavCommand | null {
  const spoken = wordsOf(transcript).join(" ").replace(LEAD_WORDS, "").replace(TRAIL_WORDS, "");
  if (GO_BACK.test(spoken)) return { kind: "go_back" };
  if (LIST_CHATS.test(spoken)) return { kind: "list_chats" };
  const goTo = GO_TO.exec(spoken);
  if (goTo && goTo[1].split(" ").length <= MAX_TARGET_WORDS) {
    return { kind: "go_to", target: goTo[1] };
  }
  return null;
}

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[right.length];
}

/** Spaces are ignored: STT writes "fit up" for FitUp and "hands free" for hands-free. */
function similarity(left: string, right: string): number {
  const longest = Math.max(left.length, right.length);
  return longest === 0 ? 0 : 1 - editDistance(left, right) / longest;
}

/**
 * How well spoken words name `name` (0..1): the whole name, or a run of its words ("hands free"
 * for "Paseo hands-free voice words") at a slightly lower score so an exact name wins a tie.
 */
export function spokenNameScore(spokenWords: string[], name: string): number {
  const nameWords = wordsOf(name);
  const spoken = spokenWords.join("");
  if (nameWords.length === 0 || spoken.length === 0) return 0;
  let best = similarity(spoken, nameWords.join(""));
  // A run of one or two letters would match inside any title.
  if (spoken.length < 3) return best;
  const sizes = [spokenWords.length - 1, spokenWords.length, spokenWords.length + 1];
  for (const size of sizes) {
    if (size < 1 || size >= nameWords.length) continue;
    for (let start = 0; start + size <= nameWords.length; start += 1) {
      const part = nameWords.slice(start, start + size).join("");
      best = Math.max(best, similarity(spoken, part) * PART_MATCH_FACTOR);
    }
  }
  return best;
}

/** The best-named chat, newest first on a tie; null below the match threshold. */
function bestChat(
  spokenWords: string[],
  chats: VoiceChat[],
): { chat: VoiceChat; score: number } | null {
  let best: { chat: VoiceChat; score: number } | null = null;
  for (const chat of chats) {
    const score = spokenNameScore(spokenWords, chat.title ?? "");
    if (score >= MATCH_THRESHOLD && (!best || score > best.score)) best = { chat, score };
  }
  return best;
}

/**
 * The project (and chat) a go-to target names: "fitup", "fitup main chat", or a chat in the
 * current project ("main chat"). The words are split every way into project words and chat
 * words; the best score wins, and on a tie a project beats a project with a chat beats a chat
 * in the current project. null when nothing scores high enough.
 */
export function resolveGoToTarget(
  target: string,
  directory: VoiceChatProject[],
  currentProjectId: string | null,
): VoiceNavTarget | null {
  const words = wordsOf(target);
  if (words.length === 0) return null;
  // Candidates in tie order: a project alone, a project with a chat, a chat in this project.
  const candidates: Array<{ target: VoiceNavTarget; score: number }> = directory.map((project) => ({
    target: { project, chat: null },
    score: spokenNameScore(words, project.name),
  }));
  for (let split = words.length - 1; split >= 1; split -= 1) {
    const projectWords = words.slice(0, split);
    const chatWords = words.slice(split);
    for (const project of directory) {
      const projectScore = spokenNameScore(projectWords, project.name);
      if (projectScore < MATCH_THRESHOLD) continue;
      const chat = bestChat(chatWords, project.chats);
      if (!chat) continue;
      const score = (projectScore * split + chat.score * chatWords.length) / words.length;
      candidates.push({ target: { project, chat: chat.chat }, score });
    }
  }
  const current = directory.find((project) => project.projectId === currentProjectId);
  const currentChat = current ? bestChat(words, current.chats) : null;
  if (current && currentChat) {
    candidates.push({
      target: { project: current, chat: currentChat.chat },
      score: currentChat.score,
    });
  }
  let best: { target: VoiceNavTarget; score: number } | null = null;
  for (const candidate of candidates) {
    if (candidate.score >= MATCH_THRESHOLD && (!best || candidate.score > best.score)) {
      best = candidate;
    }
  }
  return best?.target ?? null;
}

/** The reply to "Which one?": an ordinal of the names read out, or a chat name. */
export function resolveChatPick(reply: string, chats: VoiceChat[]): VoiceChat | null {
  const index = spokenOrdinalIndex(reply);
  if (index !== null) return chats.slice(0, SPOKEN_CHAT_LIMIT)[index] ?? null;
  const words = wordsOf(reply).filter((word) => word !== "the");
  return bestChat(words, chats)?.chat ?? null;
}

export function findVoiceChat(
  directory: VoiceChatProject[],
  agentId: string | null,
): VoiceChatTarget | null {
  if (!agentId) return null;
  for (const project of directory) {
    const chat = project.chats.find((candidate) => candidate.agentId === agentId);
    if (chat) return { project, chat };
  }
  return null;
}

/** A chat title as it is read aloud: no emoji or paths, at most six words. */
export function spokenChatName(chat: VoiceChat): string {
  const words = prepareTextForSpeech(chat.title ?? "")
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "")
    .replace(/[.!?]+$/, "")
    .split(/\s+/)
    .filter((word) => word.length > 0);
  if (words.length === 0) return "untitled chat";
  return words.slice(0, SPOKEN_TITLE_WORDS).join(" ");
}

/** The confirmation once voice is in the new chat: "FitUp, main chat." */
export function buildArrivedSpeech(target: VoiceChatTarget): string {
  return `${target.project.name}, ${spokenChatName(target.chat)}.`;
}

export function buildAlreadyHereSpeech(target: VoiceChatTarget): string {
  return `You're already in ${target.project.name}, ${spokenChatName(target.chat)}.`;
}

export function buildNoChatsSpeech(project: VoiceChatProject): string {
  return `${project.name} has no chats.`;
}

export function buildOnlyChatSpeech(project: VoiceChatProject, chat: VoiceChat): string {
  return `${spokenChatName(chat)} is the only chat in ${project.name}.`;
}

/** "Paseo has 7 chats: a, b, c, d, e, and 2 more. Which one?" */
export function buildChatListSpeech(project: VoiceChatProject): string {
  const names = project.chats.slice(0, SPOKEN_CHAT_LIMIT).map(spokenChatName);
  const more = project.chats.length - names.length;
  const list = more > 0 ? [...names, `and ${more} more`] : names;
  return `${project.name} has ${project.chats.length} chats: ${list.join(", ")}. Which one?`;
}
