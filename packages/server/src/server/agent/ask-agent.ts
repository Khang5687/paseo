import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import { AGENT_ASK_DEFAULT_TIMEOUT_MS } from "@getpaseo/protocol/messages";
import type { AgentAskThreadInfo } from "@getpaseo/protocol/messages";

import { writeFileAtomic } from "../atomic-file.js";
import { AgentSessionForkUnsupportedError } from "./agent-manager.js";
import type { AgentManager, AgentManagerEvent } from "./agent-manager.js";
import type { ForkedNativeSession } from "./agent-sdk-types.js";
import { ForkHandleRefusedError } from "./fork-handle.js";

export interface AskThreadSettings {
  /** Rounds one thread may run before it closes. */
  maxRounds: number;
  /** Open copies the daemon keeps at once, across all askers. */
  maxOpenThreads: number;
  /** A thread with no round for this long closes. */
  idleTimeoutMs: number;
  /** Longest reply returned to the asker, in characters. */
  replyCharLimit: number;
}

export const DEFAULT_ASK_THREAD_SETTINGS: AskThreadSettings = {
  maxRounds: 10,
  maxOpenThreads: 5,
  idleTimeoutMs: 10 * 60_000,
  replyCharLimit: 4000,
};

/** Past this share of the context window, the asker is warned once. */
const FULL_WARNING_FRACTION = 0.8;
/** Provider prompt caches expire after about this long; a later round re-reads the whole copy. */
const PAUSE_NOTICE_MS = 5 * 60_000;
const CLOSED_THREAD_MEMORY = 50;
const OPEN_FORKS_FILE = "ask-agent-open-forks.json";
/** A fork a provider keeps failing to delete is given up on after this many daemon starts. */
const MAX_DISCARD_ATTEMPTS = 5;
const LEFTOVER_DISCARD_TIMEOUT_MS = 30_000;
const CLOSE_ALL_TIMEOUT_MS = 15_000;

const DENIED_PERMISSION_MESSAGE =
  "You are a temporary copy answering a question. You cannot run actions that need approval; answer from what you know and what you can read.";

export const COPY_BLOCKED_MESSAGE =
  "You are a temporary copy of another agent, answering questions. This Paseo tool is blocked for copies; answer from what you know and what you can read.";

export type AskAgentManager = Pick<
  AgentManager,
  | "forkAgentSession"
  | "discardForkedHandle"
  | "resumeAgentFromPersistence"
  | "subscribe"
  | "respondToPermission"
  | "runAgent"
  | "cancelAgentRun"
  | "closeAgent"
  | "deleteAgentState"
  | "getAgent"
>;

export interface AskRoundInput {
  agentId: string;
  question: string;
  /** Continue this thread. Omit to open the asker's thread with the agent, or reuse the open one. */
  threadId?: string;
  /** Agent id of the asker. Threads are keyed by (asker, target). */
  askerId?: string;
  /** Title of the asking agent, shown to the copy so it knows who is asking. */
  askedBy?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface AskThreadTarget {
  agentId: string;
  threadId?: string;
  askerId?: string;
}

export interface AskRoundResult {
  agentId: string;
  threadId: string;
  answer: string;
  thread: AgentAskThreadInfo;
}

/** A thread an agent on this daemon opened on another host; closed there when the agent goes. */
export interface RemoteThreadRef {
  askerId: string;
  serverId: string;
  agentId: string;
  threadId: string;
}

const OpenForkRecordSchema = z.object({
  threadId: z.string(),
  handle: z.object({
    provider: z.string(),
    sessionId: z.string(),
    nativeHandle: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
  /** Daemon starts that failed to delete this fork. */
  attempts: z.number().int().nonnegative().optional(),
});
type OpenForkRecord = z.infer<typeof OpenForkRecordSchema>;

interface Thread {
  id: string;
  /** Empty for a one-shot ask from an unidentified caller. */
  askerKey: string;
  askerId: string | undefined;
  askerTitle: string | undefined;
  targetId: string;
  oneShot: boolean;
  copyId: string | null;
  fork: ForkedNativeSession | null;
  rounds: number;
  busy: boolean;
  /** Set the moment a close starts; the thread answers "closed" from then on. */
  closed: boolean;
  closeReason: string | undefined;
  /** The copy is being forked and resumed; a close waits for it, then undoes it. */
  starting: Promise<void> | null;
  closing: Promise<void> | null;
  sourceTurns: number;
  warnedFull: boolean;
  warnedUnknownSize: boolean;
  compacted: boolean;
  lastRoundEndedAt: number | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  stopWatching: Array<() => void>;
}

interface ClosedThread {
  info: AgentAskThreadInfo;
  askerKey: string;
  targetId: string;
}

class AskAgentTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`The forked copy did not answer within ${Math.round(timeoutMs / 1000)}s`);
    this.name = "AskAgentTimeoutError";
  }
}

function buildOpeningPrompt(question: string, asker: { title?: string; id?: string }): string {
  const named = asker.title ? `the agent "${asker.title}"` : "another agent";
  const who = asker.id ? `${named} (id ${asker.id})` : named;
  return [
    "[Paseo ask_agent] This is a temporary copy of your conversation. It was made so that " +
      `${who} can ask you questions without interrupting you. The original you keeps working ` +
      "and never sees this exchange. This copy stays open for several rounds and remembers " +
      "earlier ones; the asker sends one question per round. You may ask the asker something " +
      "back inside your answer, and they can reply in the next round.",
    "Answer from what you already know, reading files if you need to. If the conversation " +
      "stops in the middle of a task, do not continue the task; the original is doing it. Do " +
      "not edit files, run commands that change anything, or message other agents; your Paseo " +
      "tools that change things are blocked. Reply with the answer only.",
    "",
    "Question:",
    question,
  ].join("\n");
}

/**
 * Multi-round questions to forked copies of agents. The first ask forks the target once and keeps
 * the copy alive; later asks with the thread id go to the same copy, which remembers earlier
 * rounds. The copy runs hidden in a read-only mode, auto-denies approval requests, and cannot call
 * mutating Paseo tools (see isCopy). One instance serves a whole daemon.
 *
 * Only an identified asker (an agent id) gets a persistent thread. An anonymous caller, such as an
 * old client, gets a one-shot ask: one round, then the copy is deleted.
 */
export class AskAgentThreads {
  private readonly threads = new Map<string, Thread>();
  private readonly openByPair = new Map<string, Thread>();
  private readonly closedThreads = new Map<string, ClosedThread>();
  private readonly copyIds = new Set<string>();
  private readonly remoteThreads = new Map<string, Map<string, RemoteThreadRef>>();
  private remoteCloser: ((ref: RemoteThreadRef) => Promise<void>) | null = null;
  private readonly settings: AskThreadSettings;
  private readonly forksFile: string;
  private persistQueue: Promise<void> = Promise.resolve();
  /** Forks no live thread owns that still need deleting; written with the live ones. */
  private undiscardedLeftovers: OpenForkRecord[] = [];
  private leftoversLoaded = false;

  constructor(
    private readonly manager: AskAgentManager,
    private readonly logger: Logger,
    options: { paseoHome: string; settings?: Partial<AskThreadSettings> },
  ) {
    this.settings = { ...DEFAULT_ASK_THREAD_SETTINGS, ...options.settings };
    this.forksFile = path.join(options.paseoHome, OPEN_FORKS_FILE);
  }

  /** The limits in force, for tool descriptions. */
  get limits(): Readonly<AskThreadSettings> {
    return this.settings;
  }

  /** True while the agent is a live ask_agent copy. Its Paseo tools are limited to reads. */
  isCopy(agentId: string): boolean {
    return this.copyIds.has(agentId);
  }

  /** Called by the daemon to close a thread on another host when its local asker goes away. */
  setRemoteCloser(closer: (ref: RemoteThreadRef) => Promise<void>): void {
    this.remoteCloser = closer;
  }

  /** Remember a thread a local agent holds on another host (or forget it once it closed). */
  trackRemoteThread(ref: RemoteThreadRef, status: "open" | "closed"): void {
    const byThread = this.remoteThreads.get(ref.askerId) ?? new Map<string, RemoteThreadRef>();
    if (status === "open") byThread.set(ref.threadId, ref);
    else byThread.delete(ref.threadId);
    if (byThread.size === 0) this.remoteThreads.delete(ref.askerId);
    else this.remoteThreads.set(ref.askerId, byThread);
  }

  /**
   * Read the leftover record file before anything can overwrite it. Never throws: an unreadable
   * file must not stop the daemon from starting.
   */
  async loadLeftovers(): Promise<void> {
    if (this.leftoversLoaded) return;
    this.leftoversLoaded = true;
    try {
      this.undiscardedLeftovers = await this.readForkRecords();
    } catch (error) {
      this.logger.warn({ err: error }, "ask_agent.leftover_load_failed");
    }
  }

  /**
   * Delete forks a previous daemon process left behind. Meant to run in the background at
   * startup: each record is bounded by a timeout, and a failure only keeps its record for the
   * next start. Never throws.
   */
  async discardLeftovers(): Promise<void> {
    await this.loadLeftovers();
    // A snapshot: forks recorded while this runs wait for the next start.
    for (const record of this.undiscardedLeftovers.slice()) {
      let keep: OpenForkRecord | null = null;
      try {
        await withTimeout(
          this.manager.discardForkedHandle(record.handle),
          LEFTOVER_DISCARD_TIMEOUT_MS,
          "discarding a leftover fork",
        );
      } catch (error) {
        const attempts = (record.attempts ?? 0) + 1;
        if (error instanceof ForkHandleRefusedError) {
          this.logger.warn({ err: error, threadId: record.threadId }, "ask_agent.leftover_refused");
        } else if (attempts >= MAX_DISCARD_ATTEMPTS) {
          this.logger.warn(
            { err: error, threadId: record.threadId, attempts },
            "ask_agent.leftover_given_up",
          );
        } else {
          this.logger.warn({ err: error, threadId: record.threadId }, "ask_agent.leftover_failed");
          keep = { ...record, attempts };
        }
      }
      this.undiscardedLeftovers = this.undiscardedLeftovers.flatMap((entry) => {
        if (entry !== record) return [entry];
        return keep ? [keep] : [];
      });
      await this.persistForks();
    }
  }

  /** One entry point for a round, a status read, or a close, shared by the tool and the RPC. */
  async act(
    input: AskRoundInput & { action?: "ask" | "status" | "close" },
  ): Promise<{ answer: string | null; thread?: AgentAskThreadInfo }> {
    const target: AskThreadTarget = {
      agentId: input.agentId,
      threadId: input.threadId,
      askerId: input.askerId,
    };
    if (input.action === "status") return { answer: null, thread: this.status(target).thread };
    if (input.action === "close") {
      return { answer: null, thread: (await this.close(target)).thread };
    }
    if (!input.question.trim()) throw new Error("question is required");
    if (!input.askerId) {
      if (input.threadId) throw new Error(noThreadMessage(input.threadId));
      return { answer: await this.askOnce(input) };
    }
    const { answer, thread } = await this.ask({ ...input, askerId: input.askerId });
    return { answer, thread };
  }

  async ask(input: AskRoundInput & { askerId: string }): Promise<AskRoundResult> {
    input.signal?.throwIfAborted();
    const thread = input.threadId
      ? this.requireOpenThread(input.threadId, input.askerId, input.agentId)
      : (this.openByPair.get(pairKey(input.askerId, input.agentId)) ??
        (await this.openThread(input, input.askerId, false)));
    if (thread.busy) {
      throw new Error(
        `Thread ${thread.id} is still answering the previous question. Wait for that answer first.`,
      );
    }
    return await this.runRound(thread, input);
  }

  /** A caller with no identity cannot come back to a thread: one round, then the copy is gone. */
  private async askOnce(input: AskRoundInput): Promise<string> {
    input.signal?.throwIfAborted();
    const thread = await this.openThread(input, "", true);
    return (await this.runRound(thread, input)).answer;
  }

  /** Thread state without asking anything. Works for closed threads the daemon still remembers. */
  status(target: AskThreadTarget): { agentId: string; thread: AgentAskThreadInfo } {
    const askerKey = target.askerId ?? "";
    const thread = target.threadId
      ? this.threads.get(target.threadId)
      : this.openByPair.get(pairKey(askerKey, target.agentId));
    if (thread) {
      this.assertOwner(thread, askerKey, target.agentId);
      return { agentId: thread.targetId, thread: this.describe(thread) };
    }
    const closed = target.threadId ? this.closedThreads.get(target.threadId) : undefined;
    if (closed) {
      this.assertOwner(closed, askerKey, target.agentId);
      return { agentId: target.agentId, thread: closed.info };
    }
    throw new Error(noThreadMessage(target.threadId));
  }

  /** Close the asker's thread. Closing a thread that is already closed reports it as closed. */
  async close(target: AskThreadTarget): Promise<{ agentId: string; thread: AgentAskThreadInfo }> {
    const askerKey = target.askerId ?? "";
    const thread = target.threadId
      ? this.threads.get(target.threadId)
      : this.openByPair.get(pairKey(askerKey, target.agentId));
    if (!thread) return this.status(target);
    this.assertOwner(thread, askerKey, target.agentId);
    await this.closeThread(thread, "closed by the asker");
    return { agentId: thread.targetId, thread: this.describe(thread) };
  }

  /** An archived agent closes every thread it asked or answers, and its threads on other hosts. */
  async handleAgentArchived(agentId: string): Promise<void> {
    const affected = [...this.threads.values()].filter(
      (thread) => thread.targetId === agentId || thread.askerId === agentId,
    );
    const remote = [...(this.remoteThreads.get(agentId)?.values() ?? [])];
    this.remoteThreads.delete(agentId);
    await Promise.all([
      ...affected.map((thread) => this.closeThread(thread, "an agent was archived")),
      ...remote.map((ref) =>
        // Best effort: if the host is away, its idle timer closes the thread.
        this.remoteCloser?.(ref).catch((error: unknown) => {
          this.logger.warn({ err: error, ...ref }, "ask_agent.remote_close_failed");
        }),
      ),
    ]);
  }

  /** Daemon stop: no copy outlives the process that made it. Bounded so a stuck provider can't hang shutdown. */
  async closeAll(reason = "the daemon is stopping"): Promise<void> {
    const closing = Promise.all([...this.threads.values()].map((t) => this.closeThread(t, reason)));
    await withTimeout(closing, CLOSE_ALL_TIMEOUT_MS, "closing ask_agent threads").catch(
      (error: unknown) => {
        this.logger.warn({ err: error }, "ask_agent.close_all_timed_out");
      },
    );
  }

  private async openThread(
    input: AskRoundInput,
    askerKey: string,
    oneShot: boolean,
  ): Promise<Thread> {
    if (this.threads.size >= this.settings.maxOpenThreads) {
      throw new Error("too many open copies; close one or use send_agent_prompt");
    }
    const thread: Thread = {
      id: randomUUID().slice(0, 8),
      askerKey,
      askerId: input.askerId,
      askerTitle: input.askedBy,
      targetId: input.agentId,
      oneShot,
      copyId: null,
      fork: null,
      rounds: 0,
      busy: true,
      closed: false,
      closeReason: undefined,
      starting: null,
      closing: null,
      sourceTurns: 0,
      warnedFull: false,
      warnedUnknownSize: false,
      compacted: false,
      lastRoundEndedAt: null,
      idleTimer: null,
      stopWatching: [],
    };
    // Registered before the first await so a concurrent ask finds it and a full daemon refuses.
    this.threads.set(thread.id, thread);
    if (!oneShot) this.openByPair.set(pairKey(askerKey, input.agentId), thread);
    const starting = this.startCopy(thread);
    thread.starting = starting;
    try {
      await starting;
    } catch (error) {
      await this.closeThread(thread, "the copy could not start");
      if (error instanceof AgentSessionForkUnsupportedError) {
        throw new Error("This agent can't be copied; use send_agent_prompt.", { cause: error });
      }
      throw error;
    }
    thread.starting = null;
    if (thread.closed) {
      await thread.closing;
      throw new Error(`Thread ${thread.id} was closed: ${thread.closeReason}.`);
    }
    thread.busy = false;
    return thread;
  }

  /**
   * Fork and resume the copy. A close that arrives meanwhile waits for this to settle and then
   * undoes what it made, so every await is followed by a look at `thread.closed`.
   */
  private async startCopy(thread: Thread): Promise<void> {
    const source = this.manager.getAgent(thread.targetId);
    const fork = await this.manager.forkAgentSession(thread.targetId);
    thread.fork = fork;
    await this.persistForks();
    if (thread.closed) return;
    // The copy always answers on the source's model; the stored handle may predate a switch.
    const copy = await this.manager.resumeAgentFromPersistence(fork.handle, {
      internal: true,
      modeId: fork.readOnlyModeId,
      ...(source?.config.model ? { model: source.config.model } : {}),
      ...(source?.config.thinkingOptionId
        ? { thinkingOptionId: source.config.thinkingOptionId }
        : {}),
    });
    const copyId = copy.id;
    thread.copyId = copyId;
    this.copyIds.add(copyId);
    if (thread.closed) return;
    thread.stopWatching.push(
      this.manager.subscribe(
        (event: AgentManagerEvent) => {
          if (event.type !== "agent_stream") return;
          if (event.event.type === "permission_requested") {
            this.manager
              .respondToPermission(copyId, event.event.request.id, {
                behavior: "deny",
                message: DENIED_PERMISSION_MESSAGE,
              })
              .catch((error: unknown) => {
                this.logger.warn({ err: error, copyId }, "ask_agent.permission_deny_failed");
              });
          } else if (event.event.type === "timeline" && event.event.item.type === "compaction") {
            thread.compacted = true;
          }
        },
        { agentId: copyId, includeInternal: true, replayState: false },
      ),
      this.manager.subscribe(
        (event: AgentManagerEvent) => {
          if (event.type === "agent_stream" && event.event.type === "turn_completed") {
            thread.sourceTurns += 1;
          }
        },
        { agentId: thread.targetId, includeInternal: true, replayState: false },
      ),
    );
  }

  private async runRound(thread: Thread, input: AskRoundInput): Promise<AskRoundResult> {
    const copyId = thread.copyId;
    if (thread.closed) throw new Error(closedMessage(thread.id, thread.closeReason));
    if (!copyId) throw new Error(`Thread ${thread.id} has no copy`);
    thread.busy = true;
    this.clearIdleTimer(thread);
    const startedAt = Date.now();
    const pausedMs = thread.lastRoundEndedAt === null ? 0 : startedAt - thread.lastRoundEndedAt;
    const prompt =
      thread.rounds === 0
        ? buildOpeningPrompt(input.question, { title: thread.askerTitle, id: thread.askerId })
        : input.question;
    let answer: string;
    try {
      const result = await runUntil(
        this.manager.runAgent(copyId, prompt),
        input.timeoutMs ?? AGENT_ASK_DEFAULT_TIMEOUT_MS,
        input.signal,
        () => this.manager.cancelAgentRun(copyId),
      );
      answer = result.finalText.trim();
      if (!answer) {
        throw new Error(
          result.canceled
            ? "The forked copy was canceled before answering"
            : "The forked copy gave no answer",
        );
      }
    } catch (error) {
      // A failed round leaves the copy in an unknown state; the next one would build on it.
      const closedByOther = thread.closed;
      const reason = thread.closeReason;
      await this.closeThread(thread, "a round failed");
      if (closedByOther) {
        throw new Error(closedMessage(thread.id, reason), { cause: error });
      }
      throw error;
    }
    thread.rounds += 1;
    thread.busy = false;
    thread.lastRoundEndedAt = Date.now();
    const notes: string[] = [];
    const lastRound = thread.rounds >= this.settings.maxRounds;
    const cap = this.settings.replyCharLimit;
    if (answer.length > cap) {
      const hint =
        lastRound || thread.oneShot
          ? "Ask again with a narrower question for the rest."
          : `Ask a follow-up with threadId ${thread.id} for the rest, for example "continue from character ${cap}".`;
      notes.push(`Reply cut: showing ${cap} of ${answer.length} characters. ${hint}`);
      answer = `${answer.slice(0, cap)}\n\n[Reply cut at ${cap} of ${answer.length} characters. ${hint}]`;
    }
    if (pausedMs > PAUSE_NOTICE_MS) {
      notes.push(
        `${Math.round(pausedMs / 60_000)} minutes passed since the last round. A big session costs more to continue after a pause.`,
      );
    }
    this.noteFullness(thread, copyId, notes);
    if (thread.closed) {
      // Closed by someone else while the answer was arriving; the answer is still good.
      await thread.closing;
    } else if (thread.compacted) {
      notes.push(
        "copy got full and started forgetting; start a new thread or use send_agent_prompt",
      );
      await this.closeThread(thread, "the copy got full and compacted");
    } else if (thread.oneShot) {
      await this.closeThread(thread, "one-shot ask");
    } else if (lastRound) {
      notes.push(
        `This was the last round (${thread.rounds} of ${this.settings.maxRounds}). The thread is closed.`,
      );
      await this.closeThread(thread, "round limit reached");
    } else {
      this.armIdleTimer(thread);
    }
    return {
      agentId: thread.targetId,
      threadId: thread.id,
      answer,
      thread: this.describe(thread, notes),
    };
  }

  private noteFullness(thread: Thread, copyId: string, notes: string[]): void {
    const usage = this.manager.getAgent(copyId)?.lastUsage;
    const used = usage?.contextWindowUsedTokens;
    const max = usage?.contextWindowMaxTokens;
    if (used === undefined || max === undefined || max <= 0) {
      if (!thread.warnedUnknownSize) {
        thread.warnedUnknownSize = true;
        notes.push("Copy size unknown.");
      }
      return;
    }
    const share = used / max;
    if (share >= FULL_WARNING_FRACTION && !thread.warnedFull) {
      thread.warnedFull = true;
      notes.push(
        `The copy is ${Math.round(share * 100)}% full (${used} of ${max} tokens). If it compacts, it starts forgetting and this thread closes.`,
      );
    }
  }

  private describe(thread: Thread, notes: string[] = []): AgentAskThreadInfo {
    const maxRounds = this.settings.maxRounds;
    return {
      threadId: thread.id,
      status: thread.closed ? "closed" : "open",
      round: thread.rounds,
      maxRounds,
      roundsLeft: thread.closed ? 0 : Math.max(0, maxRounds - thread.rounds),
      ...(thread.closed && thread.closeReason ? { closeReason: thread.closeReason } : {}),
      sourceTurnsSince: thread.sourceTurns,
      notes,
    };
  }

  private requireOpenThread(threadId: string, askerKey: string, agentId: string): Thread {
    const thread = this.threads.get(threadId);
    if (!thread) {
      const closed = this.closedThreads.get(threadId);
      if (closed) {
        this.assertOwner(closed, askerKey, agentId);
        throw new Error(closedMessage(threadId, closed.info.closeReason));
      }
      throw new Error(noThreadMessage(threadId));
    }
    this.assertOwner(thread, askerKey, agentId);
    if (thread.closed) throw new Error(closedMessage(threadId, thread.closeReason));
    return thread;
  }

  private assertOwner(
    thread: { askerKey: string; targetId: string },
    askerKey: string,
    agentId: string,
  ): void {
    if (thread.askerKey !== askerKey) {
      throw new Error("That thread belongs to another asker.");
    }
    if (thread.targetId !== agentId) {
      throw new Error(`That thread is with agent ${thread.targetId}, not ${agentId}.`);
    }
  }

  private armIdleTimer(thread: Thread): void {
    this.clearIdleTimer(thread);
    thread.idleTimer = setTimeout(() => {
      void this.closeThread(thread, "idle too long");
    }, this.settings.idleTimeoutMs);
    thread.idleTimer.unref?.();
  }

  private clearIdleTimer(thread: Thread): void {
    clearTimeout(thread.idleTimer ?? undefined);
    thread.idleTimer = null;
  }

  /**
   * Close = closeAgent + deleteAgentState + fork.discard(). The thread answers "closed" from the
   * first moment, but stays in the map (holding its slot and its fork record) until the fork is
   * gone. Calling again returns the same in-flight close.
   */
  private closeThread(thread: Thread, reason: string): Promise<void> {
    if (thread.closing) return thread.closing;
    thread.closed = true;
    thread.closeReason = reason;
    this.clearIdleTimer(thread);
    for (const stop of thread.stopWatching) stop();
    thread.stopWatching = [];
    const pair = pairKey(thread.askerKey, thread.targetId);
    if (this.openByPair.get(pair) === thread) this.openByPair.delete(pair);
    thread.closing = this.finishClose(thread);
    return thread.closing;
  }

  private async finishClose(thread: Thread): Promise<void> {
    // A copy still being made is finished first, so there is exactly one thing to undo.
    if (thread.starting) await thread.starting.catch(() => undefined);
    const copyId = thread.copyId;
    if (copyId) {
      if (thread.busy) await this.manager.cancelAgentRun(copyId).catch(() => undefined);
      await this.manager.closeAgent(copyId).catch((error: unknown) => {
        this.logger.warn({ err: error, copyId }, "ask_agent.close_failed");
      });
      await this.manager.deleteAgentState(copyId).catch(() => undefined);
      this.copyIds.delete(copyId);
    }
    const fork = thread.fork;
    if (fork) {
      try {
        await fork.discard();
      } catch (error) {
        this.logger.warn({ err: error, agentId: thread.targetId }, "ask_agent.discard_failed");
        // The fork is still on disk: keep its record so the next start retries.
        this.undiscardedLeftovers.push({ threadId: thread.id, handle: fork.handle, attempts: 0 });
      }
    }
    thread.fork = null;
    this.threads.delete(thread.id);
    this.rememberClosed(thread);
    await this.persistForks();
  }

  private rememberClosed(thread: Thread): void {
    this.closedThreads.set(thread.id, {
      info: this.describe(thread),
      askerKey: thread.askerKey,
      targetId: thread.targetId,
    });
    if (this.closedThreads.size > CLOSED_THREAD_MEMORY) {
      const oldest = this.closedThreads.keys().next().value;
      if (oldest !== undefined) this.closedThreads.delete(oldest);
    }
  }

  private persistForks(): Promise<void> {
    const records: OpenForkRecord[] = [
      ...this.undiscardedLeftovers,
      ...[...this.threads.values()].flatMap((thread) =>
        thread.fork ? [{ threadId: thread.id, handle: thread.fork.handle }] : [],
      ),
    ];
    // Writes are queued so a slow earlier write can never land after a newer one.
    this.persistQueue = this.persistQueue
      .then(() => this.writeForkRecords(records))
      .catch((error: unknown) => {
        this.logger.warn({ err: error }, "ask_agent.persist_failed");
      });
    return this.persistQueue;
  }

  private async readForkRecords(): Promise<OpenForkRecord[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.forksFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const parsed = z.array(z.unknown()).safeParse(JSON.parse(raw));
    if (!parsed.success) return [];
    return parsed.data.flatMap((entry) => {
      const record = OpenForkRecordSchema.safeParse(entry);
      if (record.success) return [record.data];
      this.logger.warn({ issues: record.error.issues }, "ask_agent.leftover_record_invalid");
      return [];
    });
  }

  private async writeForkRecords(records: OpenForkRecord[]): Promise<void> {
    await writeFileAtomic(this.forksFile, `${JSON.stringify(records)}\n`);
  }
}

/** The tool's `close` and `status` flags choose the action; neither means a round. */
export function askActionOf(args: {
  close?: unknown;
  status?: unknown;
}): "ask" | "status" | "close" {
  if (args.close === true) return "close";
  return args.status === true ? "status" : "ask";
}

/** What the ask_agent tool returns, for a local or a remote answer. */
export function formatAskOutput(
  agentId: string,
  reply: { answer: string | null; thread?: AgentAskThreadInfo },
): { agentId: string; threadId?: string; answer: string | null; thread?: AgentAskThreadInfo } {
  return {
    agentId,
    ...(reply.thread ? { threadId: reply.thread.threadId } : {}),
    answer: reply.answer,
    ...(reply.thread ? { thread: reply.thread } : {}),
  };
}

function pairKey(askerKey: string, targetId: string): string {
  return `${askerKey}\u0000${targetId}`;
}

function closedMessage(threadId: string, reason: string | undefined): string {
  return `Thread ${threadId} is closed (${reason ?? "closed"}). Ask without threadId to start a new one.`;
}

function noThreadMessage(threadId: string | undefined): string {
  return threadId
    ? `No open thread ${threadId}. It may have closed; ask without threadId to start a new one.`
    : "No open thread with that agent.";
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timed out ${what} after ${Math.round(timeoutMs / 1000)}s`)),
      timeoutMs,
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([work, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

async function runUntil<T>(
  run: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  cancel: () => Promise<unknown>,
): Promise<T> {
  // The server's lib predates Promise.withResolvers.
  let stop: (error: unknown) => void = () => {};
  const stopped = new Promise<never>((_, reject) => {
    stop = reject;
  });
  const timer = setTimeout(() => stop(new AskAgentTimeoutError(timeoutMs)), timeoutMs);
  const onAbort = () => stop(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([run, stopped]);
  } catch (error) {
    // A run outlives a lost race; cancel it before the caller closes the copy.
    await cancel().catch(() => undefined);
    run.catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
