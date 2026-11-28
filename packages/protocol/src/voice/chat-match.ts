// Loose matching of spoken project and chat names, shared by the daemon (its own chats) and the
// app (every other connected host's chats), so a name scores the same wherever it lives.

import type { VoiceChat, VoiceChatProject } from "./chat-directory.js";

/** Similarity a spoken name needs to count as naming a project or chat (0..1). */
export const MATCH_THRESHOLD = 0.8;
/** A part of a longer name scores a little under the same whole name. */
const PART_MATCH_FACTOR = 0.95;
/** Scores this close name the same thing: "fitup" on two machines. */
const TIE_MARGIN = 0.01;

export interface VoiceNavTarget {
  project: VoiceChatProject;
  /** null: the project was named without a chat. */
  chat: VoiceChat | null;
}

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
export function wordsOf(text: string): string[] {
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
export function similarity(left: string, right: string): number {
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
export function bestNamedChat(
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
 * The project (and chat) a go-to target names, with its score: "fitup", "fitup main chat", or a
 * chat in the current project ("main chat"). The words are split every way into project words and
 * chat words; the best score wins, and on a tie a project beats a project with a chat beats a chat
 * in the current project. null when nothing scores high enough.
 */
export function scoreGoToTarget(
  target: string,
  directory: VoiceChatProject[],
  currentProjectId: string | null,
): { target: VoiceNavTarget; score: number } | null {
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
      const chat = bestNamedChat(chatWords, project.chats);
      if (!chat) continue;
      const score = (projectScore * split + chat.score * chatWords.length) / words.length;
      candidates.push({ target: { project, chat: chat.chat }, score });
    }
  }
  const current = directory.find((project) => project.projectId === currentProjectId);
  const currentChat = current ? bestNamedChat(words, current.chats) : null;
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
  return best;
}

export function resolveGoToTarget(
  target: string,
  directory: VoiceChatProject[],
  currentProjectId: string | null,
): VoiceNavTarget | null {
  return scoreGoToTarget(target, directory, currentProjectId)?.target ?? null;
}

/** One connected host's chats, as the app knows them. */
export interface VoiceHostChats {
  serverId: string;
  /** The host's name in the app: "Mac". */
  hostName: string;
  /** Asleep or unreachable hosts keep their last known chats so voice can say where a name is. */
  online: boolean;
  projects: VoiceChatProject[];
}

/** The project (and chat) one host has for a spoken name. */
export interface VoiceHostMatch {
  serverId: string;
  hostName: string;
  online: boolean;
  project: VoiceChatProject;
  /** null: the project was named without a chat. */
  chatAgentId: string | null;
  score: number;
}

/** The best match on each host, for a spoken go-to target. Hosts with none are left out. */
export function findHostMatches(target: string, hosts: VoiceHostChats[]): VoiceHostMatch[] {
  return hosts.flatMap((host) => {
    const best = scoreGoToTarget(target, host.projects, null);
    if (!best) return [];
    return [
      {
        serverId: host.serverId,
        hostName: host.hostName,
        online: host.online,
        project: best.target.project,
        chatAgentId: best.target.chat?.agentId ?? null,
        score: best.score,
      },
    ];
  });
}

export type VoiceHostPick<T> =
  | { kind: "go"; match: T }
  /** The same name on several machines: ask which. */
  | { kind: "choose"; matches: T[] }
  /** The only match is on a host that is offline or asleep. */
  | { kind: "offline"; match: T };

/**
 * Picks among one match per host: the best online one, a choice when online hosts tie, or the
 * best offline one when no online host matches. null when nothing matches anywhere.
 */
export function pickHostMatch<T extends { online: boolean; score: number }>(
  matches: T[],
): VoiceHostPick<T> | null {
  const online = matches.filter((match) => match.online);
  if (online.length > 0) {
    const best = Math.max(...online.map((match) => match.score));
    const tied = online.filter((match) => match.score >= best - TIE_MARGIN);
    return tied.length === 1 ? { kind: "go", match: tied[0] } : { kind: "choose", matches: tied };
  }
  const offline = [...matches].sort((left, right) => right.score - left.score)[0];
  return offline ? { kind: "offline", match: offline } : null;
}
