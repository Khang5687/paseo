// Voice commands that move live voice to another chat: "go to <project> [<chat>]",
// "list chats", "go back". Fixed English words matched on the whole utterance, no model.
// Names come from `VoiceChatProject[]` directories: this daemon's own, and the other hosts' chats
// the app finds with the same matcher (`@getpaseo/protocol/voice/chat-match`).

import type { VoiceChat, VoiceChatProject } from "@getpaseo/protocol/voice/chat-directory";
import {
  MATCH_THRESHOLD,
  bestNamedChat,
  spokenNameScore,
  wordsOf,
  type VoiceHostMatch,
} from "@getpaseo/protocol/voice/chat-match";
import { prepareTextForSpeech } from "./speech-text.js";
import { spokenOrdinalIndex } from "./spoken-question.js";

export type VoiceNavCommand =
  | { kind: "go_to"; target: string }
  | { kind: "list_chats" }
  | { kind: "go_back" };

/** Another connected host, as the app names it. */
export interface VoiceHostRef {
  serverId: string;
  hostName: string;
}

/** A chat and the project it is in; `host` is set when it lives on another machine. */
export interface VoiceChatTarget {
  project: VoiceChatProject;
  chat: VoiceChat;
  host?: VoiceHostRef;
}

/** A chat by id; `serverId` null is this host. */
export interface VoiceChatRef {
  serverId: string | null;
  agentId: string;
}

/** What the daemon asks the app about its other hosts (`voice.navigate.find_chats.request`). */
export type VoiceFindChatsQuery =
  | { kind: "name"; target: string }
  | { kind: "chat"; serverId: string; agentId: string };

export interface VoiceFindChatsAnswer {
  /** The app's name for this host: "Omen". */
  hostName: string;
  matches: VoiceHostMatch[];
}

/**
 * What voice remembers across chats on one socket. The app turns voice off and on again for
 * every move, which starts a new voice session, so this lives outside it.
 */
export interface VoiceNavMemory {
  currentAgentId: string | null;
  /** Where "go back" goes: a chat here, or on the host voice came from. */
  previous: VoiceChatRef | null;
  /** Spoken once voice is on in `agentId`: "FitUp, main chat." */
  arrival: { agentId: string; speech: string } | null;
}

export function createVoiceNavMemory(): VoiceNavMemory {
  return { currentAgentId: null, previous: null, arrival: null };
}
/** How many chat names are read aloud before "and N more". */
export const SPOKEN_CHAT_LIMIT = 5;
/** Longest chat title read aloud, in words. */
const SPOKEN_TITLE_WORDS = 6;
/** Most words a "go to" target may have; longer is a sentence for the agent. */
const MAX_TARGET_WORDS = 8;

export const NO_CHAT_SPEECH = "No chat called that.";
export const NO_PREVIOUS_CHAT_SPEECH = "No previous chat.";
export const NO_MACHINE_SPEECH = "No machine called that.";

const LEAD_WORDS = /^(?:(?:ok|okay|hey|please|now|and|so) )+/;
const TRAIL_WORDS = /(?: (?:please|now|over))+$/;
const GO_TO = /^(?:go|switch|jump|take me) to (?:the )?(.+)$/;
const LIST_CHATS =
  /^(?:list|show|which|what)(?: are)?(?: the| my| all)?(?: the)? chats?(?: are (?:there|open)| do i have| in this project)?$/;
const GO_BACK = /^go back(?: to the (?:last|previous) (?:chat|one))?$/;

/**
 * Reads a whole utterance as a navigation command, or null for anything else. "Go to the auth
 * module and add logging" parses as a go-to; it becomes a command only when its target names a
 * project or chat (see `scoreGoToTarget`), otherwise it is talk for the agent.
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

/** The reply to "Which one?": an ordinal of the names read out, or a chat name. */
export function resolveChatPick(reply: string, chats: VoiceChat[]): VoiceChat | null {
  const index = spokenOrdinalIndex(reply);
  if (index !== null) return chats.slice(0, SPOKEN_CHAT_LIMIT)[index] ?? null;
  const words = wordsOf(reply).filter((word) => word !== "the");
  return bestNamedChat(words, chats)?.chat ?? null;
}

/** The reply to "On Omen or on Mac?": an ordinal, or a host name ("the Mac", "on Omen"). */
export function resolveHostPick(reply: string, hostNames: string[]): number | null {
  const index = spokenOrdinalIndex(reply);
  if (index !== null) return index < hostNames.length ? index : null;
  const words = wordsOf(reply).filter((word) => word !== "the" && word !== "on");
  let best: { index: number; score: number } | null = null;
  for (const [candidate, name] of hostNames.entries()) {
    const score = spokenNameScore(words, name);
    if (score >= MATCH_THRESHOLD && (!best || score > best.score)) {
      best = { index: candidate, score };
    }
  }
  return best?.index ?? null;
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

/** "FitUp", or "FitUp on Mac" for a project on another machine. */
export function spokenProjectName(project: VoiceChatProject, host?: VoiceHostRef): string {
  return host ? `${project.name} on ${host.hostName}` : project.name;
}

/** The confirmation once voice is in the new chat: "FitUp, main chat." */
export function buildArrivedSpeech(target: VoiceChatTarget): string {
  return `${spokenProjectName(target.project, target.host)}, ${spokenChatName(target.chat)}.`;
}

export function buildAlreadyHereSpeech(target: VoiceChatTarget): string {
  return `You're already in ${target.project.name}, ${spokenChatName(target.chat)}.`;
}

export function buildNoChatsSpeech(project: VoiceChatProject, host?: VoiceHostRef): string {
  return `${spokenProjectName(project, host)} has no chats.`;
}

export function buildOnlyChatSpeech(project: VoiceChatProject, chat: VoiceChat): string {
  return `${spokenChatName(chat)} is the only chat in ${project.name}.`;
}

/** "Paseo has 7 chats: a, b, c, d, e, and 2 more. Which one?" */
export function buildChatListSpeech(project: VoiceChatProject, host?: VoiceHostRef): string {
  const names = project.chats.slice(0, SPOKEN_CHAT_LIMIT).map(spokenChatName);
  const more = project.chats.length - names.length;
  const list = more > 0 ? [...names, `and ${more} more`] : names;
  return `${spokenProjectName(project, host)} has ${project.chats.length} chats: ${list.join(", ")}. Which one?`;
}

/** "FitUp on Omen or on Mac?"; names that differ are each said: "FitUp on Omen or Fit up on Mac?" */
export function buildChooseHostSpeech(
  choices: Array<{ project: VoiceChatProject; hostName: string }>,
): string {
  const sameName = choices.every((choice) => choice.project.name === choices[0].project.name);
  const options = choices.map((choice, index) =>
    sameName && index > 0
      ? `on ${choice.hostName}`
      : `${choice.project.name} on ${choice.hostName}`,
  );
  return `${options.join(" or ")}?`;
}

export function buildHostOfflineSpeech(project: VoiceChatProject, hostName: string): string {
  return `${project.name} is on ${hostName}, which is offline.`;
}

export function buildPreviousOfflineSpeech(hostName: string): string {
  return `Your last chat is on ${hostName}, which is offline.`;
}
