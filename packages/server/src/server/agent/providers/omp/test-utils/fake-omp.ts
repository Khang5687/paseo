import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { onTestFinished } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { AccountRoutingAuthority } from "../../../../account-routing/authority.js";
import { AccountRoutingStore } from "../../../../account-routing/store.js";
import type { OmpRoutingBlock } from "@getpaseo/protocol/messages";
import type {
  AccountRoutingClock,
  OmpRoutingAccountRef as OmpAccountRef,
  RoutingCatalog,
  RoutingCatalogAccount,
} from "../../../../account-routing/types.js";
import type {
  OmpRuntime,
  OmpRuntimeLaunch,
  OmpRuntimeSession,
  OmpStartSessionInput,
} from "../runtime.js";
import type {
  OmpRpcHostToolDefinition,
  OmpRpcHostToolResult,
  OmpRpcHostToolUpdate,
  OmpAgentMessage,
  OmpGoalAction,
  OmpGoalModeState,
  OmpModel,
  OmpLoginExisting,
  OmpLoginResult,
  OmpLogoutAccount,
  OmpPromptAck,
  OmpRpcSlashCommand,
  OmpRuntimeEvent,
  OmpSessionState,
  OmpSessionStats,
  OmpThinkingLevel,
} from "../rpc-types.js";
import { buildOmpLaunch } from "../runtime.js";

type FakeOmpSubagentSubscriptionLevel = "off" | "progress" | "events";
type FakeOmpSubagentStatus = "pending" | "running" | "completed" | "failed" | "aborted";

export interface FakeOmpSubagentSnapshot {
  id: string;
  index: number;
  agent: string;
  description?: string;
  status: FakeOmpSubagentStatus;
  task?: string;
  assignment?: string;
  sessionFile?: string;
  parentToolCallId?: string;
  lastUpdate?: number;
}

export interface FakeOmpSubagentMessagesSelector {
  subagentId?: string;
  sessionFile?: string;
  fromByte?: number;
}

export interface FakeOmpSubagentMessagesResult {
  sessionFile: string;
  fromByte: number;
  nextByte: number;
  reset: boolean;
  messages: OmpAgentMessage[];
}

export class FakeOmp implements OmpRuntime {
  readonly recordedLaunches: OmpRuntimeLaunch[] = [];
  private readonly sessions: FakeOmpSession[] = [];
  private readonly command: [string, ...string[]];
  private readonly queuedCommands: OmpRpcSlashCommand[][] = [];
  private readonly queuedSessionSetups: Array<(session: FakeOmpSession) => void> = [];
  private readonly removedModels = new Set<string>();
  private nextStartError: Error | null = null;
  private nextSessionId = 0;
  private readonly sessionIdsByFile = new Map<string, string>();
  private readonly queuedSubagentSubscriptionErrors = new Map<
    FakeOmpSubagentSubscriptionLevel,
    Error
  >();

  constructor(command: [string, ...string[]] = ["omp"]) {
    this.command = command;
  }

  async startSession(input: OmpStartSessionInput): Promise<FakeOmpSession> {
    const startError = this.nextStartError;
    this.nextStartError = null;
    if (startError) throw startError;
    const launch = buildOmpLaunch({
      command: this.command,
      session: input,
    });
    this.recordedLaunches.push(launch);
    if (launch.model && this.removedModels.has(launch.model)) {
      throw new Error(`Model "${launch.model}" not found`);
    }
    const sessionId =
      (launch.session ? this.sessionIdsByFile.get(launch.session) : undefined) ??
      `omp-session-${++this.nextSessionId}`;
    const session = new FakeOmpSession(launch, sessionId, this.removedModels);
    if (!launch.noSession) this.sessionIdsByFile.set(session.state.sessionFile, sessionId);
    session.commands = this.queuedCommands.shift() ?? [];
    for (const [level, error] of this.queuedSubagentSubscriptionErrors) {
      session.subagentSubscriptionErrors.set(level, error);
    }
    this.queuedSubagentSubscriptionErrors.clear();
    this.queuedSessionSetups.shift()?.(session);
    this.sessions.push(session);
    return session;
  }

  queueCommands(commands: OmpRpcSlashCommand[]): void {
    this.queuedCommands.push(commands);
  }

  queueSessionSetup(setup: (session: FakeOmpSession) => void): void {
    this.queuedSessionSetups.push(setup);
  }

  // OMP refuses to launch with, or switch to, a model it no longer knows.
  removeModel(modelId: string): void {
    this.removedModels.add(modelId);
  }

  failNextStart(error: Error): void {
    this.nextStartError = error;
  }

  failNextSubagentSubscription(level: FakeOmpSubagentSubscriptionLevel, error: Error): void {
    this.queuedSubagentSubscriptionErrors.set(level, error);
  }

  latestSession(): FakeOmpSession {
    const session = this.sessions.at(-1);
    if (!session) {
      throw new Error("FakeOmp has no sessions");
    }
    return session;
  }

  allSessions(): FakeOmpSession[] {
    return [...this.sessions];
  }
}

export class FakeOmpSession implements OmpRuntimeSession {
  readonly environment: Record<string, string>;
  fastModeResult = { enabled: false, active: false };
  readonly setFastModeRequests: boolean[] = [];
  readonly prompts: Array<{ message: string; imageCount: number }> = [];
  readonly compactRequests: Array<{ customInstructions?: string }> = [];
  readonly setAutoCompactionRequests: boolean[] = [];
  readonly goalRequests: OmpGoalAction[] = [];
  goalState: OmpGoalModeState | null = null;
  goalError: Error | null = null;
  readonly subagentSubscriptionRequests: FakeOmpSubagentSubscriptionLevel[] = [];
  readonly subagentMessageRequests: FakeOmpSubagentMessagesSelector[] = [];
  readonly setModelRequests: Array<{ provider: string; modelId: string }> = [];
  readonly setThinkingLevelRequests: OmpThinkingLevel[] = [];
  readonly handoffRequests: Array<{ customInstructions?: string }> = [];
  readonly steerRequests: Array<{ message: string; imageCount: number }> = [];
  steerError: Error | null = null;
  readonly followUpRequests: Array<{ message: string; imageCount: number }> = [];
  readonly hostToolSetRequests: OmpRpcHostToolDefinition[][] = [];
  readonly hostToolResults: OmpRpcHostToolResult[] = [];
  readonly hostToolUpdates: OmpRpcHostToolUpdate[] = [];
  getStateRequestCount = 0;
  abortRequested = false;
  readonly loginRequests: string[] = [];
  readonly loginOptions: Array<{ existing?: OmpLoginExisting }> = [];
  /**
   * Scripts one login: emit events, await the reply to a UI request, then resolve or throw.
   * Resolving with nothing is an old OMP's bare success.
   */
  loginHandler: ((session: FakeOmpSession) => Promise<OmpLoginResult | void>) | null = null;
  /** What `get_logout_accounts` lists; a handler may change it to model the login's write. */
  logoutAccounts: OmpLogoutAccount[] = [];
  logoutAccountsError: Error | null = null;
  getLogoutAccountsRequests = 0;
  private rejectWhenClosed: (error: Error) => void = () => undefined;
  private readonly closedSignal = new Promise<never>((_, reject) => {
    this.rejectWhenClosed = reject;
  });
  abortError: Error | null = null;
  onAbort: (() => void) | null = null;
  private heldStateRequests: Array<() => void> | null = null;
  readonly canceledExtensionUiRequests: string[] = [];
  readonly extensionUiResponses: Array<{
    id: string;
    response: { value?: string; confirmed?: boolean; cancelled?: boolean };
  }> = [];
  setModelResult: OmpModel | null = null;
  models: OmpModel[] = [];
  messages: OmpAgentMessage[] = [];
  stats: OmpSessionStats = {
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
  };
  commands: OmpRpcSlashCommand[] = [];
  refreshCommandsRequestCount = 0;
  refreshCommandsError: Error | null = null;
  subagents: FakeOmpSubagentSnapshot[] = [];
  readonly subagentSubscriptionErrors = new Map<FakeOmpSubagentSubscriptionLevel, Error>();
  compactError: Error | null = null;
  // Real OMP RPC answers `compact` without streaming compaction_start/end
  // (those only reach the TUI). Opt in to mirror runtimes that do stream them.
  streamCompactionEvents = false;
  getStateError: Error | null = null;
  promptAck: OmpPromptAck = {};
  branchResponse: { text?: string; cancelled?: boolean } = { text: "" };
  branchMessages: Array<{ entryId: string; text: string }> = [];
  readonly branchRequests: string[] = [];
  activeBranchEntryId?: string;
  closed = false;
  state: OmpSessionState;

  private readonly subscribers = new Set<(event: OmpRuntimeEvent) => void>();
  private readonly stateReports: OmpSessionState[] = [];
  private readonly stateRequestWaiters: Array<{ count: number; resolve: () => void }> = [];
  private readonly hostToolResultWaiters: Array<(result: OmpRpcHostToolResult) => void> = [];
  private readonly promptWaiters: Array<() => void> = [];
  private readonly subscriptionWaiters: Array<{ count: number; resolve: () => void }> = [];
  private readonly subagentMessageResults = new Map<string, FakeOmpSubagentMessagesResult[]>();
  private nextHeldPrompt: { promise: Promise<void>; reject: (error: Error) => void } | null = null;
  private activeHeldPrompt: { promise: Promise<void>; reject: (error: Error) => void } | null =
    null;

  constructor(
    launch: OmpRuntimeLaunch,
    sessionId = "omp-session-1",
    private readonly removedModels: ReadonlySet<string> = new Set(),
  ) {
    this.environment = launch.env ?? {};
    this.closedSignal.catch(() => undefined);
    this.state = {
      model: null,
      thinkingLevel: "medium",
      isStreaming: false,
      isCompacting: false,
      autoCompactionEnabled: true,
      fastModeEnabled: false,
      fastModeActive: false,
      sessionFile: launch.session ?? "/tmp/omp-session",
      sessionId,
      messageCount: 0,
      queuedMessageCount: 0,
    };
  }

  onEvent(callback: (event: OmpRuntimeEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  async prompt(
    message: string,
    images?: Array<{ type: "image"; data: string; mimeType: string }>,
  ): Promise<OmpPromptAck> {
    if (this.state.isStreaming || this.state.isCompacting) {
      throw new Error("Agent is already processing");
    }
    this.prompts.push({ message, imageCount: images?.length ?? 0 });
    this.promptWaiters.shift()?.();
    const heldPrompt = this.nextHeldPrompt;
    if (heldPrompt) {
      this.nextHeldPrompt = null;
      this.activeHeldPrompt = heldPrompt;
      try {
        await heldPrompt.promise;
      } finally {
        if (this.activeHeldPrompt === heldPrompt) {
          this.activeHeldPrompt = null;
        }
      }
    }
    return this.promptAck;
  }

  nextPrompt(): Promise<void> {
    return new Promise((resolve) => this.promptWaiters.push(resolve));
  }

  holdNextPrompt(): void {
    if (this.nextHeldPrompt || this.activeHeldPrompt) {
      throw new Error("FakeOmp already has a held prompt");
    }
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((_resolve, rejectPromise) => {
      reject = rejectPromise;
    });
    this.nextHeldPrompt = { promise, reject };
  }

  async failHeldPrompt(error: Error): Promise<void> {
    const heldPrompt = this.activeHeldPrompt ?? this.nextHeldPrompt;
    if (!heldPrompt) {
      throw new Error("FakeOmp has no held prompt");
    }
    heldPrompt.reject(error);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  async compact(customInstructions?: string): Promise<void> {
    this.compactRequests.push(customInstructions === undefined ? {} : { customInstructions });
    if (this.streamCompactionEvents) {
      this.emit({ type: "compaction_start", reason: "manual" });
    }
    if (this.compactError) {
      throw this.compactError;
    }
    if (this.streamCompactionEvents) {
      this.emit({ type: "compaction_end", reason: "manual" });
    }
  }

  async goal(action: OmpGoalAction): Promise<OmpGoalModeState | null> {
    this.goalRequests.push(action);
    if (this.goalError) {
      throw this.goalError;
    }
    switch (action.op) {
      case "get":
        return this.goalState;
      case "create": {
        const now = Date.now();
        const existing = this.goalState?.goal;
        const goal = {
          id: existing?.id ?? `goal-${this.goalRequests.length}`,
          objective: action.objective ?? "",
          status: "active",
          ...(action.token_budget !== undefined ? { tokenBudget: action.token_budget } : {}),
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        this.goalState = { enabled: true, mode: "active", goal };
        this.emit({ type: "goal_updated", goal, state: this.goalState });
        return this.goalState;
      }
      case "pause":
      case "resume": {
        if (!this.goalState?.goal) {
          throw new Error(
            action.op === "pause" ? "No active goal to pause." : "No paused goal to resume.",
          );
        }
        const status = action.op === "pause" ? "paused" : "active";
        const goal = { ...this.goalState.goal, status, updatedAt: Date.now() };
        this.goalState = { enabled: status === "active", mode: "active", goal };
        this.emit({ type: "goal_updated", goal, state: this.goalState });
        return this.goalState;
      }
      case "drop": {
        if (!this.goalState?.goal) {
          throw new Error("No goal to drop.");
        }
        const goal = { ...this.goalState.goal, status: "dropped", updatedAt: Date.now() };
        this.goalState = null;
        this.emit({ type: "goal_updated", goal, state: { enabled: false, mode: "none" } });
        return null;
      }
    }
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    this.setAutoCompactionRequests.push(enabled);
    this.state = {
      ...this.state,
      autoCompactionEnabled: enabled,
    };
  }

  async login(
    providerId: string,
    options: { existing?: OmpLoginExisting } = {},
  ): Promise<OmpLoginResult> {
    this.loginRequests.push(providerId);
    this.loginOptions.push(options);
    // Like the real transport, closing the process fails a login that is still waiting.
    const result = await Promise.race([
      this.loginHandler?.(this) ?? Promise.resolve(),
      this.closedSignal,
    ]);
    return result ?? { kind: "stored" };
  }

  async getLogoutAccounts(_providerId: string): Promise<OmpLogoutAccount[]> {
    this.getLogoutAccountsRequests += 1;
    if (this.logoutAccountsError) throw this.logoutAccountsError;
    return this.logoutAccounts.map((account) => ({ ...account }));
  }

  async abort(): Promise<void> {
    if (this.abortError) {
      throw this.abortError;
    }
    this.abortRequested = true;
    // OMP can stream a turn's teardown before it answers the abort request.
    this.onAbort?.();
  }

  async getState(): Promise<OmpSessionState> {
    this.getStateRequestCount += 1;
    for (const waiter of this.stateRequestWaiters.splice(0)) {
      if (this.getStateRequestCount >= waiter.count) waiter.resolve();
      else this.stateRequestWaiters.push(waiter);
    }
    if (this.heldStateRequests) {
      const held = this.heldStateRequests;
      await new Promise<void>((resolve) => held.push(resolve));
    }
    if (this.getStateError) {
      throw this.getStateError;
    }
    const report = this.stateReports.shift();
    if (report) {
      this.state = report;
    }
    // Real OMP reports the goal mode state alongside the session state.
    return { ...this.state, goal: this.goalState };
  }

  async setFastMode(enabled: boolean): Promise<{ enabled: boolean; active: boolean }> {
    this.setFastModeRequests.push(enabled);
    this.state = {
      ...this.state,
      fastModeEnabled: this.fastModeResult.enabled,
      fastModeActive: this.fastModeResult.active,
    };
    return this.fastModeResult;
  }

  /** Holds every state request until the returned function releases them. */
  holdStateRequests(): () => void {
    const held: Array<() => void> = [];
    this.heldStateRequests = held;
    return () => {
      this.heldStateRequests = null;
      for (const resolve of held.splice(0)) resolve();
    };
  }

  queueStateReports(states: OmpSessionState[]): void {
    this.stateReports.push(...states);
  }

  waitForStateRequests(count: number): Promise<void> {
    if (this.getStateRequestCount >= count) return Promise.resolve();
    return new Promise((resolve) => this.stateRequestWaiters.push({ count, resolve }));
  }

  async getMessages(): Promise<OmpAgentMessage[]> {
    return this.messages;
  }

  async getAvailableModels(_timeoutMs?: number | null): Promise<OmpModel[]> {
    return this.models;
  }

  async setModel(provider: string, modelId: string): Promise<OmpModel> {
    this.setModelRequests.push({ provider, modelId });
    if (this.removedModels.has(`${provider}/${modelId}`)) {
      throw new Error(`Model not found: ${provider}/${modelId}`);
    }
    if (!this.setModelResult) {
      throw new Error("FakeOmp setModel requires setModelResult to be scripted");
    }
    this.state = { ...this.state, model: this.setModelResult };
    return this.setModelResult;
  }

  async setThinkingLevel(level: OmpThinkingLevel): Promise<void> {
    this.setThinkingLevelRequests.push(level);
  }

  async getSessionStats(): Promise<OmpSessionStats> {
    return this.stats;
  }

  async setSubagentSubscription(level: FakeOmpSubagentSubscriptionLevel): Promise<void> {
    this.subagentSubscriptionRequests.push(level);
    for (const waiter of this.subscriptionWaiters.splice(0)) {
      if (this.subagentSubscriptionRequests.length >= waiter.count) waiter.resolve();
      else this.subscriptionWaiters.push(waiter);
    }
    const error = this.subagentSubscriptionErrors.get(level);
    if (error) {
      throw error;
    }
  }

  waitForSubagentSubscriptions(count: number): Promise<void> {
    if (this.subagentSubscriptionRequests.length >= count) return Promise.resolve();
    return new Promise((resolve) => this.subscriptionWaiters.push({ count, resolve }));
  }

  async setHostTools(tools: OmpRpcHostToolDefinition[]): Promise<string[]> {
    this.hostToolSetRequests.push(tools);
    return tools.map((tool) => tool.name);
  }

  async branch(entryId: string): Promise<{ text: string }> {
    this.branchRequests.push(entryId);
    if (this.branchResponse.cancelled === true) {
      throw new Error("OMP branch was cancelled");
    }
    if (typeof this.branchResponse.text !== "string") {
      throw new Error("FakeOmp branch response requires text");
    }
    this.activeBranchEntryId = entryId;
    return { text: this.branchResponse.text };
  }

  async getBranchMessages(): Promise<Array<{ entryId: string; text: string }>> {
    return this.branchMessages;
  }

  async steer(
    message: string,
    images?: Array<{ type: "image"; data: string; mimeType: string }>,
  ): Promise<void> {
    this.steerRequests.push({ message, imageCount: images?.length ?? 0 });
    if (this.steerError) throw this.steerError;
  }

  followUp(
    message: string,
    images?: Array<{ type: "image"; data: string; mimeType: string }>,
  ): void {
    this.followUpRequests.push({ message, imageCount: images?.length ?? 0 });
  }

  sendHostToolResult(result: OmpRpcHostToolResult): void {
    this.hostToolResults.push(result);
    this.hostToolResultWaiters.shift()?.(result);
  }

  sendHostToolUpdate(update: OmpRpcHostToolUpdate): void {
    this.hostToolUpdates.push(update);
  }

  nextHostToolResult(): Promise<OmpRpcHostToolResult> {
    return new Promise((resolve) => this.hostToolResultWaiters.push(resolve));
  }

  async getSubagents(): Promise<FakeOmpSubagentSnapshot[]> {
    return this.subagents;
  }

  async getSubagentMessages(
    selector: FakeOmpSubagentMessagesSelector,
  ): Promise<FakeOmpSubagentMessagesResult> {
    this.subagentMessageRequests.push(selector);
    const key = selector.sessionFile ?? selector.subagentId;
    if (!key) {
      throw new Error("FakeOmp getSubagentMessages requires a selector");
    }
    const results = this.subagentMessageResults.get(key);
    const result = results?.shift();
    if (!result) {
      throw new Error(`FakeOmp has no subagent messages queued for ${key}`);
    }
    return result;
  }

  queueSubagentMessages(result: FakeOmpSubagentMessagesResult): void {
    const results = this.subagentMessageResults.get(result.sessionFile) ?? [];
    results.push(result);
    this.subagentMessageResults.set(result.sessionFile, results);
  }

  async getCommands(): Promise<OmpRpcSlashCommand[]> {
    return this.commands;
  }

  async refreshCommands(): Promise<OmpRpcSlashCommand[]> {
    this.refreshCommandsRequestCount += 1;
    if (this.refreshCommandsError) throw this.refreshCommandsError;
    return this.commands;
  }

  async handoff(customInstructions?: string): Promise<void> {
    this.handoffRequests.push(customInstructions ? { customInstructions } : {});
  }

  respondToExtensionUiRequest(
    id: string,
    response: { value?: string; confirmed?: boolean; cancelled?: boolean },
  ): void {
    this.extensionUiResponses.push({ id, response });
  }

  cancelExtensionUiRequest(id: string): void {
    this.canceledExtensionUiRequests.push(id);
    this.respondToExtensionUiRequest(id, { cancelled: true });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.rejectWhenClosed(new Error("OMP RPC session is closed"));
  }

  emit(event: OmpRuntimeEvent): void {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }

  finishTurn(message: OmpAgentMessage = { role: "assistant", content: [] }): void {
    this.messages = [...this.messages, message];
    this.emit({ type: "agent_end", messages: this.messages });
  }

  finishTurnWithEmptyAgentEnd(message: OmpAgentMessage = { role: "assistant", content: [] }): void {
    this.messages = [...this.messages, message];
    this.emit({ type: "message_end", message });
    this.emit({ type: "agent_end", messages: [] });
  }

  beginTurn(): void {
    this.emit({ type: "turn_start" });
  }

  acceptPrompt(text: string, entryId = "omp-user-1"): void {
    this.emit({
      type: "message_end",
      message: { role: "user", content: text, entryId } as OmpAgentMessage,
    });
  }

  acceptCustomMessage(content: string): void {
    this.emit({
      type: "message_end",
      message: { role: "custom", content },
    });
  }

  streamAssistantText(text: string, responseId = "omp-assistant-1"): void {
    const message: OmpAgentMessage = {
      role: "assistant",
      content: [],
      responseId,
    };
    this.emit({ type: "message_start", message });
    this.emit({
      type: "message_update",
      message,
      assistantMessageEvent: { type: "text_delta", delta: text },
    });
  }

  requestToolApproval(input: {
    id: string;
    tool: "bash" | "edit" | "write";
    detail: string;
  }): void {
    let detailLabel = "Path";
    if (input.tool === "bash") {
      detailLabel = "Command";
    } else if (input.tool === "edit") {
      detailLabel = "File";
    }
    this.emit({
      type: "extension_ui_request",
      id: input.id,
      method: "select",
      title: `Allow tool: ${input.tool}\n${detailLabel}: ${input.detail}`,
      options: ["Approve", "Deny"],
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Account-routing fixtures: a fake OMP child that speaks the native JSONL control frames
// (oh-my-pi `docs/rpc.md`, "Host-Owned Account Routing") over real pipes. Synthetic data only.
// ---------------------------------------------------------------------------------------------

export const ROUTING_NAMESPACE = "11111111-1111-4111-8111-111111111111";
export const ROUTING_MODEL = "claude-sonnet-4-5";
export const ROUTING_T0 = 1_000_000;

export function routingRef(nativeRowId: number, storeNamespace = ROUTING_NAMESPACE): OmpAccountRef {
  return { storeNamespace, nativeRowId };
}

export function routingAccount(
  row: number,
  patch: Partial<RoutingCatalogAccount> = {},
  namespace = ROUTING_NAMESPACE,
): RoutingCatalogAccount {
  return {
    ref: routingRef(row, namespace),
    display: {
      email: `user${row}@example.test`,
      accountId: `acct-${row}`,
      organizationId: `org-${row}`,
      organizationName: `Org ${row}`,
    },
    credentialAvailable: true,
    quotaIdentity: { accountUuid: `acct-${row}`, organizationUuid: `org-${row}` },
    billing: {
      state: "disabled",
      observedAt: ROUTING_T0,
      validUntil: ROUTING_T0 + 300_000,
      source: "claude-usage-spend",
      sourceRevision: null,
      reason: null,
    },
    subscriptionTier: { kind: "unknown", observedAt: null, source: null },
    windows: [],
    quotaBlocks: [],
    rank: {
      method: "claude-native-window-pressure-v1",
      version: 1,
      modelId: ROUTING_MODEL,
      modelFamily: "sonnet",
      planGateApplies: false,
      planEligibility: true,
      billingEligibility: "eligible",
      applicableLimitIds: [],
      coverage: "complete",
      unknownReasons: [],
      usageMeasured: true,
      primaryHot: false,
      primaryUsed: 0.1,
      secondaryUsed: 0.1,
      primaryRequiredDrain: 0,
      secondaryRequiredDrain: 0,
    },
    ...patch,
  };
}

export function routingCatalog(
  runtimeInstanceId: string,
  accounts: RoutingCatalogAccount[],
  patch: Partial<RoutingCatalog> = {},
): RoutingCatalog {
  return {
    provider: "anthropic",
    runtimeInstanceId,
    storeNamespace: ROUTING_NAMESPACE,
    catalogRevision: 1,
    nativeCredentialGeneration: 1,
    observedAt: ROUTING_T0,
    authoritativeObservedAt: ROUTING_T0,
    authoritativeComplete: true,
    accounts,
    ...patch,
  };
}

/** Two-account catalog where every row carries one shared 5h block (or none when `resetAt` is absent). */
export function routingBlockedCatalog(
  runtimeInstanceId: string,
  catalogRevision: number,
  resetAt: number | null,
  observedAt: number,
): RoutingCatalog {
  const accounts = [routingAccount(1), routingAccount(2)];
  if (resetAt !== null) {
    for (const account of accounts) {
      account.quotaBlocks = [
        {
          limitId: "5h",
          scope: { kind: "shared" },
          resetAt,
          observedAt: ROUTING_T0,
          source: "native-usage",
          confirmed: true,
        },
      ];
    }
  }
  return routingCatalog(runtimeInstanceId, accounts, { catalogRevision, observedAt });
}

type JsonRecord = Record<string, unknown>;

type ScriptedReply = { error: string } | JsonRecord;

export interface FakeOmpChildOptions {
  /** Answer to `account.routing.configure`. Default: complete coverage, one namespace. */
  configure?: (command: JsonRecord) => { error: string } | JsonRecord;
  /** Catalogs the configure reply carries, given the host's runtimeInstanceId. */
  catalogs?: (runtimeInstanceId: string) => RoutingCatalog[];
  /** Frames the child writes in the same burst as the configure reply (startup work it held). */
  afterConfigure?: (runtimeInstanceId: string) => JsonRecord[];
  refresh?: (command: JsonRecord) => ScriptedReply | Promise<ScriptedReply>;
  rank?: (command: JsonRecord) => ScriptedReply | Promise<ScriptedReply>;
}

/**
 * Scripted OMP child process. Every frame the host writes lands in `received`; the child answers
 * ordinary commands, so a real `OmpCliRuntime` and `OmpAgentSession` run against it unchanged.
 */
export class FakeOmpChild {
  readonly process: ChildProcessWithoutNullStreams;
  readonly received: JsonRecord[] = [];
  isStreaming = false;
  private readonly waiters: Array<{ match: (frame: JsonRecord) => boolean; resolve: () => void }> =
    [];
  private readonly stdin = new PassThrough();
  private readonly stdout = new PassThrough();

  constructor(private readonly options: FakeOmpChildOptions = {}) {
    const child = Object.assign(new EventEmitter(), {
      stdin: this.stdin,
      stdout: this.stdout,
      stderr: new PassThrough(),
      exitCode: null,
      signalCode: null,
    }) as unknown as ChildProcessWithoutNullStreams;
    child.kill = ((signal?: NodeJS.Signals | number) => {
      queueMicrotask(() => child.emit("exit", null, signal ?? null));
      return true;
    }) as ChildProcessWithoutNullStreams["kill"];
    this.process = child;
    this.stdout.write(
      `${JSON.stringify({
        type: "ready",
        protocolVersion: 1,
        supportedProtocolVersions: [1],
        maxFrameBytes: 1024 * 1024,
        maxReassembledFrameBytes: 64 * 1024 * 1024,
      })}\n`,
    );
    let buffer = "";
    this.stdin.on("data", (chunk) => {
      buffer += chunk.toString();
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        this.receive(JSON.parse(line) as JsonRecord);
      }
    });
  }

  /** Write one native frame to the host. */
  emit(frame: JsonRecord): void {
    this.stdout.write(`${JSON.stringify(frame)}\n`);
  }

  exit(code = 0): void {
    this.process.emit("exit", code, null);
  }

  framesOfType(type: string): JsonRecord[] {
    return this.received.filter((frame) => frame.type === type);
  }

  /** Resolves when the host has written a frame matching `type` (and `where`), including earlier ones. */
  waitForFrame(
    type: string,
    where: (frame: JsonRecord) => boolean = () => true,
  ): Promise<JsonRecord> {
    const match = (frame: JsonRecord) => frame.type === type && where(frame);
    const held = this.received.find(match);
    if (held) return Promise.resolve(held);
    return new Promise((resolve) => {
      this.waiters.push({
        match,
        resolve: () => resolve(this.received.find(match) as JsonRecord),
      });
    });
  }

  private receive(command: JsonRecord): void {
    this.received.push(command);
    for (const waiter of this.waiters.splice(0)) {
      if (waiter.match(command)) waiter.resolve();
      else this.waiters.push(waiter);
    }
    if (typeof command.id !== "string") return;
    const type = String(command.type);
    if (type === "account.routing.configure") return this.answerConfigure(command);
    if (type === "account.routing.refresh")
      return this.answerScripted(command, this.options.refresh);
    if (type === "account.routing.rank") {
      // Default mirrors a native rank of equally good candidates.
      const refs = (command.candidateRefs as OmpAccountRef[]) ?? [];
      return this.answerScripted(
        command,
        this.options.rank ??
          (() => ({
            method: "claude-native-window-pressure-v1",
            version: 1,
            catalogRevision: command.catalogRevision,
            anchorRef: refs[0] ?? null,
            bestCloseRefs: refs,
          })),
      );
    }
    if (type === "get_state") {
      return this.respond(command, {
        model: null,
        thinkingLevel: "medium",
        isStreaming: this.isStreaming,
        isCompacting: false,
        autoCompactionEnabled: true,
        fastModeEnabled: false,
        fastModeActive: false,
        sessionFile: "/tmp/omp-session",
        sessionId: "omp-session-1",
        messageCount: 0,
        queuedMessageCount: 0,
      });
    }
    if (type === "set_host_tools") return this.respond(command, { toolNames: [] });
    this.respond(command, {});
  }

  private answerConfigure(command: JsonRecord): void {
    const runtimeInstanceId = String(command.runtimeInstanceId);
    const scripted = this.options.configure?.(command);
    if (scripted && "error" in scripted) return this.fail(command, String(scripted.error));
    const catalogs = this.options.catalogs?.(runtimeInstanceId) ?? [
      routingCatalog(runtimeInstanceId, [routingAccount(1), routingAccount(2)]),
    ];
    this.respond(command, {
      version: 1,
      configured: true,
      completeCoverage: true,
      modelDispatch: "allowed",
      purposes: ["main", "subagent", "title"],
      accessibleNamespaces: [ROUTING_NAMESPACE],
      catalogs,
      ...scripted,
    });
    for (const frame of this.options.afterConfigure?.(runtimeInstanceId) ?? []) this.emit(frame);
  }

  private async answerScripted(
    command: JsonRecord,
    script: ((command: JsonRecord) => ScriptedReply | Promise<ScriptedReply>) | undefined,
  ): Promise<void> {
    const reply = await script?.(command);
    if (!reply) return this.fail(command, "unsupported_runtime");
    if ("error" in reply) return this.fail(command, String(reply.error));
    this.respond(command, reply);
  }

  private respond(command: JsonRecord, data: unknown): void {
    this.emit({ id: command.id, type: "response", command: command.type, success: true, data });
  }

  private fail(command: JsonRecord, code: string): void {
    this.emit({
      id: command.id,
      type: "response",
      command: command.type,
      success: false,
      error: code,
      code,
    });
  }
}

export interface RoutingPoolRow {
  /** "expired" is a disabled observation whose validity already ended. */
  billing?: "disabled" | "enabled" | "unknown" | "expired";
  blocks?: OmpRoutingBlock[];
  /** Stand-in for native pressure ranking: lower `used` is more headroom. */
  used?: number;
  email?: string | null;
  organizationName?: string | null;
  credentialAvailable?: boolean;
}

/**
 * Mutable synthetic native store for N accounts. Every read stamps fresh observation times, so a
 * catalog never expires mid-test; `update` bumps the catalog revision the way native does.
 * Wire it as `ompRouting: pool.options()`.
 */
export class RoutingPool {
  revision = 1;
  private rows = new Map<number, RoutingPoolRow>();
  private reversed = false;

  constructor(count: number) {
    for (let row = 1; row <= count; row += 1) this.rows.set(row, {});
  }

  get size() {
    return this.rows.size;
  }

  update(row: number, patch: RoutingPoolRow): void {
    this.rows.set(row, { ...this.rows.get(row), ...patch });
    this.revision += 1;
  }

  add(row: number, patch: RoutingPoolRow = {}): void {
    this.rows.set(row, patch);
    this.revision += 1;
  }

  remove(row: number): void {
    this.rows.delete(row);
    this.revision += 1;
  }

  /** Native lists the same identities in a different order. */
  reverseOrder(): void {
    this.reversed = !this.reversed;
    this.revision += 1;
  }

  catalogFor = (runtimeInstanceId: string): RoutingCatalog => {
    const now = Date.now();
    const accounts: RoutingCatalogAccount[] = [];
    for (const [row, state] of this.rows) {
      const account = routingAccount(row);
      if (state.email !== undefined) account.display.email = state.email;
      if (state.organizationName !== undefined) {
        account.display.organizationName = state.organizationName;
        account.display.organizationId = null;
      }
      account.credentialAvailable = state.credentialAvailable ?? true;
      account.billing.state =
        state.billing === "expired" ? "disabled" : (state.billing ?? "disabled");
      account.billing.observedAt = now;
      account.billing.validUntil = state.billing === "expired" ? now - 1 : now + 300_000;
      account.quotaBlocks = state.blocks ?? [];
      account.rank.primaryUsed = state.used ?? 0.1;
      accounts.push(account);
    }
    if (this.reversed) accounts.reverse();
    return routingCatalog(runtimeInstanceId, accounts, {
      catalogRevision: this.revision,
      observedAt: now,
      authoritativeObservedAt: now,
    });
  };

  /** Native answers a refresh with its current catalog. */
  options(): FakeOmpChildOptions {
    return {
      catalogs: (id) => [this.catalogFor(id)],
      refresh: (command) => ({ catalog: this.catalogFor(String(command.runtimeInstanceId)) }),
      rank: (command) => {
        const refs = (command.candidateRefs as OmpAccountRef[]) ?? [];
        const used = (ref: OmpAccountRef) => this.rows.get(ref.nativeRowId)?.used ?? 0.1;
        const best = Math.min(...refs.map(used));
        const close = refs.filter((ref) => used(ref) === best);
        return {
          method: "claude-native-window-pressure-v1",
          version: 1,
          catalogRevision: command.catalogRevision,
          anchorRef: close[0] ?? null,
          bestCloseRefs: close,
        };
      },
    };
  }
}

export class RoutingClock implements AccountRoutingClock {
  time = ROUTING_T0;
  private timers: Array<{ at: number; callback: () => void; live: boolean }> = [];
  now() {
    return this.time;
  }
  setTimer(callback: () => void, delayMs: number) {
    const timer = { at: this.time + delayMs, callback, live: true };
    this.timers.push(timer);
    return () => {
      timer.live = false;
    };
  }
  advance(ms: number) {
    this.time += ms;
    for (const timer of this.timers.filter((t) => t.live && t.at <= this.time)) {
      timer.live = false;
      timer.callback();
    }
  }
}

export function routingHost() {
  const dir = mkdtempSync(path.join(tmpdir(), "paseo-omp-routing-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const clock = new RoutingClock();
  let ids = 0;
  const authority = new AccountRoutingAuthority({
    store: AccountRoutingStore.open(path.join(dir, "account-routing.json")),
    clock,
    newId: () => `host-${++ids}`,
  });
  return { authority, clock };
}
